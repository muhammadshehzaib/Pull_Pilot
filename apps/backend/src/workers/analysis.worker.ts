import { Worker, Job, UnrecoverableError } from 'bullmq';
import { redisConnection } from '../config/redis';
import prisma from '../config/prisma';
import { EncryptionService } from '../services/encryption.service';
import { GitHubAppService } from '../services/github-app.service';
import { AiProviderFactory } from '../services/ai/ai-factory';
import { SocketService } from '../config/socket';
import { ConfigService } from '../services/config.service';
import { RulesService } from '../services/rules.service';
import { runSecurityProbes, countByProbe } from '../services/security/run-probes';
import { OsvClient } from '../services/security/osv-client';
import { fetchChangedFileContents } from '../services/changed-files.service';
import { assessRisk, assessExplainableRisk } from '../services/security/risk-engine';
import { DiffFilterService } from '../services/diff-filter.service';
import { buildReviewContext } from '../services/context-builder';
import type { ReviewContext } from '../services/ai/context-prompt';
import { sortBySeverity } from '../services/ai/finding-taxonomy';
import { deduplicate } from '../services/ai/finding-dedup.service';
import { baselineBehavioral } from '../services/behavioral/contracts';
import { runTestGapAnalysis } from '../services/test-gap/test-gap.service';
import type { TestGapReport } from '../services/test-gap/test-gap-types';
import { prepareReviewDelivery, loadReviewDelivery, deliverReviewPlan } from '../services/comment-delivery.service';
import type { GitHubService } from '../services/github.service';
import { reviewBackoff } from '../services/review-backoff';
import { DELIVERY_TERMINAL_STATES } from '../services/comment-delivery-report';
import { recordJobFindings } from '../services/historical/occurrence.service';
import { RISK_ALGORITHM_VERSION } from '../services/analytics/facts';
import { retrieveFeedbackAdaptation, adaptationAttribution } from '../services/feedback-loop/adaptation.service';
import { retrieveHistoricalMemory, type HistoricalReviewContext } from '../services/historical/review-memory.service';
import {
  severityTally,
} from '../services/ai/finding-format';
import { PermanentJobError, isPermanentJobError } from '../errors/permanent-job.error';
import { advanceReview, markReviewTerminal, wasSuperseded, isTerminalStatus, persistReviewFailure } from './job-state';
import { ANALYSIS_QUEUE_NAME, REVIEW_TIMEOUT_MS, CLAUDE_MODEL, GROK_MODEL } from '../utils/constants';

export const analysisWorker = new Worker(
  ANALYSIS_QUEUE_NAME,
  async (job: Job) => {
    console.log(`\n⚙️  WORKER: Awakening for Job ${job.id}...`);

    const {
      jobId,
      repositoryId,
      userId,
      fullName,
      eventType,
      referenceId,
      payloadSnapshot,
      githubInstallationId,
    } = job.data;

    const [owner, repo] = fullName.split('/');

    /**
     * Set when this attempt is abandoned — by the deadline below, or by someone
     * cancelling the review while a provider call is still outstanding. Read at
     * step boundaries so an abandoned review never goes on to post comments onto
     * a PR the user cancelled or a review already written off as timed out.
     */
    let superseded = false;

    /**
     * Cancels any in-flight provider request once the attempt is abandoned. A
     * Node-side abort makes the SDK close the socket instead of waiting for its
     * own timeout to expire.
     */
    const abort = new AbortController();

    /**
     * Awaits `p` but rejects as soon as the attempt is abandoned, so the worker
     * slot is released even when the underlying operation ignores the abort
     * signal — otherwise one hung request would occupy one of the five slots
     * forever and starve every other review.
     */
    const guard = <T>(p: Promise<T>): Promise<T> => {
      if (abort.signal.aborted) {
        return Promise.reject(new UnrecoverableError('Review was abandoned before this call ran.'));
      }
      const aborted = new Promise<never>((_, reject) => {
        abort.signal.addEventListener(
          'abort',
          () => reject(new UnrecoverableError('Review was cancelled or timed out mid-flight; abandoning.')),
          { once: true },
        );
      });
      // If `p` wins the race, the abort promise can still reject later; make sure
      // that never surfaces as an unhandled rejection.
      aborted.catch(() => {});
      return Promise.race([p, aborted]);
    };

    /**
     * Abandons this attempt if the review was cancelled or timed out.
     *
     * Checks the in-process flag first so the overwhelmingly common case costs
     * nothing, then the persisted status so a cancellation issued by another
     * process is still noticed. Throws UnrecoverableError: the reason the
     * attempt was dropped is not something a retry could resolve.
     */
    const assertNotSuperseded = async (): Promise<void> => {
      if (!superseded && !(await wasSuperseded(jobId))) return;
      superseded = true;
      throw new UnrecoverableError(
        'Review was cancelled or timed out before this attempt finished; abandoning without posting.',
      );
    };

    const deadline = setTimeout(() => {
      superseded = true;
      abort.abort();
      console.error(
        `⏱️  REVIEW TIMED OUT after ${REVIEW_TIMEOUT_MS}ms: ${jobId} (${fullName} ${eventType} ${referenceId}). Marking TIMEOUT and abandoning this attempt.`,
      );
      // Best-effort: the pipeline may be blocked on a promise that will not settle
      // soon, and a failure to record the timeout must not take the worker with it.
      void markReviewTerminal(
        jobId,
        userId,
        'TIMEOUT',
        `⏱️ Review timed out after ${Math.round(REVIEW_TIMEOUT_MS / 1000)}s and was abandoned.`,
        { reason: 'review-timeout', error: `Exceeded the ${REVIEW_TIMEOUT_MS}ms review budget.` },
      ).catch((err) => {
        console.error(`Could not persist TIMEOUT for ${jobId}:`, err);
      });
    }, REVIEW_TIMEOUT_MS);

    const finishDelivery = async (plan: NonNullable<Awaited<ReturnType<typeof loadReviewDelivery>>>, service?: GitHubService) => {
      const { artifact } = await guard(deliverReviewPlan(plan, service, abort.signal));
      await assertNotSuperseded();
      await recordJobFindings(jobId, repositoryId, artifact.suggestions, JSON.parse(JSON.stringify(artifact)));
      const partial = artifact.commentFailures?.length > 0;
      SocketService.emitStatus(userId, jobId, partial ? 'Review completed with partial comment delivery. See delivery details.' : 'Review and comment delivery completed.', 'COMPLETED', { suggestions: artifact.suggestions });
      return { status: 'success', findingCount: artifact.suggestions.length };
    };

    try {
      // Resume saved delivery before requiring an AI key or invoking a provider.
      const persisted = await prisma.analysisJob.findUnique({ where: { id: jobId },
        include: { repository: { include: { installation: true } } } });
      if (!persisted || !persisted.repository.isActive || persisted.repository.userId !== userId || persisted.repositoryId !== repositoryId) {
        throw new UnrecoverableError('Review or repository unavailable');
      }
      if (isTerminalStatus(persisted.status)) return { status: 'already-terminal' };
      if (persisted.eventType === 'PULL_REQUEST' && persisted.deliveryVersion !== 1) {
        await markReviewTerminal(jobId, userId, 'SKIPPED', 'Legacy review delivery is untracked; start a new review.', { reason: 'legacy-delivery-untracked' });
        throw new UnrecoverableError('Legacy review delivery is untracked');
      }
      const savedPlan = await loadReviewDelivery(jobId);
      if (savedPlan) {
        const finished = savedPlan.deliveries?.every(r => (DELIVERY_TERMINAL_STATES as readonly string[]).includes(r.state));
        const service = finished ? undefined : await GitHubAppService.getInstallationService(persisted.repository.installation?.githubInstallationId?.toString());
        return await finishDelivery(savedPlan, service);
      }
      // 1. Enter the pipeline. Every step below advances the phase rather than
      //    re-asserting RUNNING, so the dashboard reflects real progress.
      await advanceReview(jobId, userId, 'FETCHING', '🚀 Worker Active: Analysis Cycle Commenced');

      // 2. Fetch User associated with Repository & retrieve their SECURE KEY
      const dbRepo = await prisma.repository.findUnique({
        where: { id: repositoryId },
        include: { user: { include: { vault: true } }, installation: true },
      });

      if (!dbRepo || !dbRepo.user.vault) {
        // Retrying cannot help: the user must save a key first. See errors/permanent-job.error.ts.
        throw new PermanentJobError(
          'missing-api-key',
          'No AI API key found in your vault. Please go to API Key Vault (/vault) and save your API key first.',
        );
      }

      const vault = dbRepo.user.vault;
      console.log(`🔑 Vault Detected: Using user preference [${vault.provider}] engine.`);
      SocketService.emitStatus(userId, jobId, `🔐 Unlocking Security Vault [Provider: ${vault.provider}]`, 'FETCHING');

      // 3. DECRYPT THE KEY IN RAM TEMPORARILY
      const rawApiKey = EncryptionService.decrypt(
        vault.encryptedGeminiKey,
        vault.iv,
        vault.authTag,
        vault.salt
      );

      // 4. BOOT MULTI-TENANT GITHUB APP CONNECTOR
      const resolvedInstallationId = githubInstallationId || dbRepo.installation?.githubInstallationId?.toString();
      const ghService = await GitHubAppService.getInstallationService(resolvedInstallationId);

      // 5. FETCH REPO CONFIGURATION (.aipr.yml)
      const { baseSha, headSha } = payloadSnapshot;
      SocketService.emitStatus(userId, jobId, `⚙️ Inspecting repository rules (.aipr.yml)`, 'FETCHING');
      const repoConfig = await guard(ConfigService.fetchRepoConfig(ghService, owner, repo, headSha));

      // 5b. LOAD DB-STORED ENGINEERING RULES (dashboard-managed). These merge
      //     with the .aipr.yml guidelines below: one combined prompt block for
      //     the model, plus a deterministic pass that runs regardless of what
      //     the model chooses to report.
      const dbRules = await guard(
        prisma.repositoryRule.findMany({
          where: { repositoryId, enabled: true },
          orderBy: { createdAt: 'asc' },
        }),
      );

      // 6. FETCH & FILTER RAW DIFF STREAM
      SocketService.emitStatus(userId, jobId, `📡 Fetching & Filtering Diff Stream`, 'FETCHING');
      const rawDiff = await guard(ghService.fetchDiff(owner, repo, baseSha, headSha));

      await assertNotSuperseded();

      if (!rawDiff || rawDiff.length < 5) {
        console.log(`💨 Diff empty or too small. Finishing early.`);
        await recordJobFindings(jobId, repositoryId, [], { suggestions: [] });
        return { status: 'success', findingCount: 0 };
      }

      // Filter out files specified in .aipr.yml ignore list
      const { filteredDiff, ignoredFiles, includedFiles } = DiffFilterService.filterDiff(rawDiff, repoConfig);

      if (ignoredFiles.length > 0) {
        console.log(`🛡️ Ignored ${ignoredFiles.length} files matching .aipr.yml patterns: ${ignoredFiles.join(', ')}`);
      }

      if (!filteredDiff || filteredDiff.trim().length < 5) {
        console.log(`💨 Diff empty after applying .aipr.yml ignore filters. Finishing early.`);
        SocketService.emitStatus(userId, jobId, `💨 All changed files matched ignore rules. No audit required.`, 'COMPLETED');
        await recordJobFindings(jobId, repositoryId, [], { suggestions: [], ignoredFiles, includedFiles });
        return { status: 'success', findingCount: 0 };
      }

      // 6b. DETERMINISTIC RULE ENGINE. Runs on the filtered diff — ignored
      //     files are never scanned — before the model is called, so rule
      //     violations exist even if the provider later fails or simply fails
      //     to notice them. LLM-only rules yield SKIPPED check records.
      const ruleEvaluation = RulesService.evaluateRules(dbRules, filteredDiff);
      if (ruleEvaluation.checks.length > 0) {
        const failed = ruleEvaluation.checks.filter((c) => c.status === 'FAIL').length;
        console.log(
          `📏 Repository rules: ${ruleEvaluation.checks.length} checked, ${failed} failed, ${ruleEvaluation.violations.length} violation(s).`,
        );
        SocketService.emitStatus(
          userId,
          jobId,
          `📏 ${ruleEvaluation.checks.length} repository rule(s) checked — ${failed} failed`,
          'ANALYZING',
        );
      }

      // .aipr.yml guidelines first, then dashboard rules; the provider injects
      // the combined list as "ADDITIONAL USER RULES TO ENFORCE".
      const promptGuidelines = RulesService.mergeGuidelines(repoConfig.guidelines, dbRules);

      // 6c. DETERMINISTIC SECURITY PROBES. SAST + hardcoded-secrets +
      //     known-vulnerable-dependencies, all run on the filtered diff before
      //     the model is called. Findings bypass min_severity exactly like rule
      //     violations: a deterministic scanner must not be silently optional
      //     behind a repo-wide threshold. Each probe writes a PASS/FAIL row.
      //
      //     The dependency probe consults the live OSV.dev advisory database
      //     (falling back to the bundled offline registry if unreachable), and
      //     when enabled the extra Semgrep SAST pass runs over the full content
      //     of the changed files — fetched here because a diff carries only
      //     hunks.
      let semgrepFiles: Map<string, string> | undefined;
      if (repoConfig.security.enabled && repoConfig.security.semgrep) {
        SocketService.emitStatus(userId, jobId, `🔬 Gathering changed files for Semgrep`, 'FETCHING');
        semgrepFiles = await guard(
          fetchChangedFileContents(ghService, owner, repo, headSha, includedFiles),
        );
      }

      const securityScan = await guard(
        runSecurityProbes(repoConfig.security, filteredDiff, {
          osv: repoConfig.security.osv ? new OsvClient() : undefined,
          dependencyDiff: rawDiff,
          semgrep: semgrepFiles && semgrepFiles.size > 0 ? { files: semgrepFiles } : undefined,
        }),
      );
      const probeTallies = countByProbe(securityScan.findings);
      if (securityScan.checks.length > 0) {
        const failed = securityScan.checks.filter((c) => c.status === 'FAIL').length;
        console.log(
          `🛡️ Security probes: ${securityScan.checks.length} checked, ${failed} failed, ${securityScan.findings.length} finding(s) — ` +
            `SAST ${probeTallies.SAST} · secrets ${probeTallies.SECRETS} · dependencies ${probeTallies.DEPENDENCIES}.`,
        );
        SocketService.emitStatus(
          userId,
          jobId,
          `🛡️ Security probes: ${securityScan.findings.length} finding(s) — SAST ${probeTallies.SAST} · secrets ${probeTallies.SECRETS} · dependencies ${probeTallies.DEPENDENCIES}`,
          'ANALYZING',
        );
      }

      // 7. ENGAGE AI ENGINE VIA FACTORY
      console.log(`🧠 Contacting ${vault.provider} for Analysis Strategy...`);

      // Context is gathered after filtering so ignored files are never read,
      // and after assertNotSuperseded() so an abandoned job stops early.
      let context: ReviewContext | undefined;
      if (repoConfig.context.enabled) {
        SocketService.emitStatus(userId, jobId, `🔎 Reading surrounding code for context`, 'FETCHING');
        context = await guard(buildReviewContext({
          ghService,
          owner,
          repo,
          repositoryId: dbRepo.id,
          headSha,
          changedPaths: includedFiles,
          config: repoConfig.context,
          ignore: repoConfig.ignore,
          signal: abort.signal,
        }));
        await assertNotSuperseded();

        if (context) {
          console.log(`🔎 Context: ${context.files.length} file(s), ${context.files.reduce((n, f) => n + f.content.length, 0)} chars`);
        } else {
          console.log(`🔎 Context: unavailable, reviewing diff only`);
        }
      }

      await advanceReview(jobId, userId, 'ANALYZING', `🧠 AI Dispatching to ${vault.provider} Models`);

      // 6d. OPT-IN HISTORICAL REVIEW MEMORY (Phase 8).
      //     Retrieves bounded cross-PR historical patterns for the repo.
      //     Safety boundaries: guidance only, never suppresses security checks.
      const feedbackAdaptation = await guard(retrieveFeedbackAdaptation(dbRepo.id));
      let historicalMemory: HistoricalReviewContext | null = null;
      try {
        historicalMemory = await guard(retrieveHistoricalMemory(dbRepo.id, includedFiles));
        if (historicalMemory?.patterns.length) {
          console.log(
            `📜 [Phase8] Supplied ${historicalMemory.patterns.length} historical pattern(s) to review prompt (IDs: ${historicalMemory.suppliedPatternIds.join(', ')}).`,
          );
        }
      } catch (memErr) {
        console.warn('⚠️ [Phase8] Historical memory retrieval error (proceeding without memory):', memErr);
      }

      const aiDriver = AiProviderFactory.getProvider(vault.provider, rawApiKey);
      const rawSuggestions = await guard(
        aiDriver.analyzeCode(
          filteredDiff,
          promptGuidelines,
          context,
          { signal: abort.signal, historicalContext: historicalMemory?.serializedContext,
            feedbackContext: feedbackAdaptation?.serializedContext },
        ),
      );

      // The provider call is the step most likely to overrun, so this is the
      // first place it matters whether the review was abandoned while we waited.
      await assertNotSuperseded();

      // 8. FILTER SUGGESTIONS BY MIN_SEVERITY, DEDUPE, SORT MOST SEVERE FIRST
      //
      // Deterministic rule violations AND security findings join the model's
      // findings here. Both are deliberately NOT passed through the min_severity
      // filter: the user configured rules explicitly and the security layer is a
      // hard control, so each engine's own severity decides — burying either
      // behind a repo-wide threshold would make a DETERMINISTIC control silently
      // optional.
      const mergedFindings = sortBySeverity(
        deduplicate([
          ...rawSuggestions.filter((s) => DiffFilterService.isSeverityMet(s.priority, repoConfig.min_severity)),
          ...ruleEvaluation.violations,
          ...securityScan.findings,
        ]),
      );

      // The risk engine turns the merged list into one number and verdict, and
      // annotates findings whose deterministic detection lines up with a model
      // (or rule) finding on the same lines — corroboration that makes a
      // borderline report much more trustworthy.
      const { findings: suggestions, report: risk } = assessRisk(mergedFindings, {
        blockOnCriticalSecret: repoConfig.security.block_on_critical_secret,
      });
      const feedbackAttribution = adaptationAttribution(suggestions, feedbackAdaptation);

      console.log(
        `🎯 AI Analysis Finished! Found ${rawSuggestions.length} model finding(s) + ${ruleEvaluation.violations.length} rule violation(s) + ${securityScan.findings.length} security finding(s); ${suggestions.length} total after dedupe (${repoConfig.min_severity} threshold applies to model findings only).`,
      );
      await advanceReview(jobId, userId, 'GENERATING', `🎯 Scan Complete: ${suggestions.length} items flagged`);
      SocketService.emitStatus(
        userId,
        jobId,
        `🛡️ Risk engine: ${risk.score}/100 — ${risk.verdict}${risk.blockingCount > 0 ? ` (${risk.blockingCount} blocking)` : ''}`,
        'GENERATING',
      );

      // 6e. TEST-GAP ANALYSIS. Best-effort and additive: it never runs tests,
      //     never blocks the review, and simply goes missing if the provider
      //     cannot do it. Optional-call via the guard inside runTestGapAnalysis
      //     keeps providers (and test doubles) that only implement analyzeCode
      //     working unchanged.
      let testGaps: TestGapReport | null = null;
      try {
        testGaps = await guard(
          runTestGapAnalysis({
            ghService,
            owner,
            repo,
            ref: headSha,
            changedPaths: includedFiles,
            provider: aiDriver,
            signal: abort.signal,
          }),
        );
        if (testGaps && testGaps.scenarios.length > 0) {
          SocketService.emitStatus(
            userId,
            jobId,
            `🧪 ${testGaps.scenarios.length} missing test scenario(s) suggested`,
            'ANALYZING',
          );
        }
      } catch (err) {
        if (superseded || err instanceof UnrecoverableError) throw err;
        console.warn('⚠️ Test-gap analysis skipped:', (err as Error).message);
      }

      const behavioral = baselineBehavioral(testGaps);
      const riskV2 = assessExplainableRisk(suggestions, {
        blockOnCriticalSecret: repoConfig.security.block_on_critical_secret,
        includedFiles, ignoredFiles, securityChecks: securityScan.checks,
        ruleChecks: ruleEvaluation.checks, testGaps, behavioral,
        context: context?.discovery?.status === 'UNAVAILABLE' ? 'NOT_RUN'
          : context ? context.incomplete || context.treeTruncated || context.droppedPaths.length > 0 ? 'PARTIAL' : 'AVAILABLE' : 'NOT_RUN',
      });

      // One record per rule per job: the durable pass/fail trail a model
      // finding could never provide. skipDuplicates keeps a retried job from
      // double-writing rows against the (job, rule) unique index.
      if (ruleEvaluation.checks.length > 0) {
        await guard(
          prisma.ruleCheck.createMany({
            data: ruleEvaluation.checks.map((check) => ({
              analysisJobId: jobId,
              ruleId: check.ruleId,
              ruleName: check.ruleName,
              status: check.status,
              violationCount: check.violationCount,
            })),
            skipDuplicates: true,
          }),
        );
      }

      // Same durable trail for the security probes: at most one row per probe
      // (SAST / SECRETS / DEPENDENCIES), so the job detail page can show a
      // per-probe PASS/FAIL independent of the findings blob.
      if (securityScan.checks.length > 0) {
        await guard(
          prisma.securityCheck.createMany({
            data: securityScan.checks.map((check) => ({
              analysisJobId: jobId,
              probe: check.probe,
              ruleKey: check.ruleKey,
              ruleName: check.ruleName,
              status: check.status,
              findingCount: check.findingCount,
              detail: check.detail ?? null,
            })),
            skipDuplicates: true,
          }),
        );
      }

      const artifact = {
            analyticsConfiguration: { riskAlgorithmVersion: RISK_ALGORITHM_VERSION, repoConfig,
              pipelineVersion: 'review_pipeline_2', provider: vault.provider,
              models: { openai: 'gpt-4o', claude: CLAUDE_MODEL, grok: GROK_MODEL, gemini: process.env.GEMINI_MODEL || 'gemini-2.5-flash' },
              rules: dbRules.map(r => ({ id: r.id, updatedAt: r.updatedAt })).sort((a, b) => a.id.localeCompare(b.id)) },
            suggestions,
            ignoredFiles,
            includedFiles,
            config: repoConfig,
            ruleChecks: ruleEvaluation.checks,
            securityChecks: securityScan.checks,
            risk,
            riskV2,
            contextDiscovery: context?.discovery,
            testGaps,
            behavioral,
            feedbackAdaptation: feedbackAttribution,
            historicalMemory: historicalMemory
              ? {
                  suppliedPatternIds: historicalMemory.suppliedPatternIds,
                  patternCount: historicalMemory.patterns.length,
                  version: historicalMemory.version,
                  algorithmVersion: historicalMemory.algorithmVersion,
                  truncated: historicalMemory.truncated,
                }
              : undefined,
      };
          const summaryBase = [
            '## 🤖 AI PR Review Summary',
            '',
            '- **Status**: Audit completed',
            `- **Findings**: ${suggestions.length} actionable items flagged (min severity: \`${repoConfig.min_severity}\`)`,
            suggestions.length > 0
              ? `- **Breakdown**: ${severityTally(suggestions)}`
              : '- **Breakdown**: no findings',
            `- **Files Reviewed**: ${includedFiles.length} files (${ignoredFiles.length} ignored via \`.aipr.yml\`)`,
            ...(ruleEvaluation.checks.length > 0
              ? [
                  `- **Repository Rules**: ${ruleEvaluation.checks.length} checked — ${
                    ruleEvaluation.checks.filter((c) => c.status === 'FAIL').length
                  } failed, ${
                    ruleEvaluation.checks.filter((c) => c.status === 'PASS').length
                  } passed, ${
                    ruleEvaluation.checks.filter((c) => c.status === 'SKIPPED').length
                  } model-enforced only`,
                ]
              : []),
            ...(securityScan.checks.length > 0
              ? [
                  `- **Security Scans**: SAST ${probeTallies.SAST} · SECRETS ${probeTallies.SECRETS} · DEPENDENCIES ${probeTallies.DEPENDENCIES} — ${
                    securityScan.checks.filter((c) => c.status === 'FAIL').length
                  } probe(s) flagged findings`,
                ]
              : []),
            `- **Security Risk**: ${risk.score}/100 — ${risk.verdict}${risk.blockingCount > 0 ? ` (${risk.blockingCount} blocking)` : ''}`,
            `- **PR Risk v2 (advisory)**: ${riskV2.score}/100 — ${riskV2.verdict}; 0 = lower indicated risk, 100 = higher. Evidence confidence: ${riskV2.coverage.confidence}.`,
            ...(testGaps && testGaps.scenarios.length > 0
              ? [`- **Test Gaps**: ${testGaps.scenarios.length} missing test scenario(s) suggested (see dashboard)`]
              : []),
            ...(riskV2.verdict === 'BLOCK'
              ? [`> **Advisory BLOCK verdict**: ${riskV2.reasons.join(' ')} GitHub merge protection is not enforced by this report.`]
              : []),
            '',
            '*Automated review powered by [AI PR Reviewer](https://reviewer.shehzaib.com)*',
          ].join('\n');
      await assertNotSuperseded();
      if (eventType === 'PULL_REQUEST') {
        const plan = await guard(prepareReviewDelivery({ jobId, repositoryId, userId, headSha, baseSha, fullName,
          prNumber: Number(referenceId), expectedAuthorId: await guard(ghService.getPostingAuthorId(abort.signal)),
          artifact, summaryBase }));
        return await finishDelivery(plan, ghService);
      }
      await recordJobFindings(jobId, repositoryId, suggestions, JSON.parse(JSON.stringify(artifact)));
      // Durable historicalRevision is reconciled by the bounded maintenance worker.

      console.log(`🏁 Job Cycle ${jobId} gracefully exited with 100% success.\n`);
      SocketService.emitStatus(userId, jobId, `✅ All Analysis Finalized. Results fully loaded.`, 'COMPLETED', { suggestions });
      return { status: 'success', findingCount: suggestions.length };
    } catch (err) {
      const message = (err as Error).message;

      // An abandoned attempt must not be rewritten as a failure. CANCELLED and
      // TIMEOUT are the accurate outcomes and were persisted by whoever stopped
      // the review; overwriting either with FAILED would tell the user their
      // review broke when in fact they — or a clock — ended it deliberately.
      // Re-thrown so BullMQ stops retrying, with no further write.
      if (superseded || err instanceof UnrecoverableError) {
        console.warn(
          `🚫 Job ${jobId} abandoned mid-flight (${superseded ? 'cancelled or timed out' : 'unrecoverable'}). Status left as-is: ${message}`,
        );
        throw err;
      }

      const permanent = isPermanentJobError(err);

      // A permanent failure is the user's to fix. SKIPPED reads as "waiting on
      // you" rather than "broken", and UnrecoverableError stops BullMQ replaying
      // a job that cannot succeed. Logged once, not once per attempt.
      if (permanent) {
        console.warn(`⏭️  JOB SKIPPED (needs user action): ${jobId} — ${message}`);

        await markReviewTerminal(jobId, userId, 'SKIPPED', message, { reason: err.reason, error: message });

        throw new UnrecoverableError(message);
      }

      // Transient: log and let BullMQ use the remaining attempts.
      console.error(`🚨 JOB FATALITY (attempt will retry): ${jobId} died:`, err);

      const attempts = Number(job.opts?.attempts ?? 1);
      const willRetry = Number(job.attemptsMade ?? 0) + 1 < attempts;
      const failureStatus = willRetry ? 'RETRYING' : 'FAILED';
      await persistReviewFailure(jobId, userId, failureStatus, message);

      throw err;
    } finally {
      // A review that finishes in 4 seconds must not leave a 10-minute timer
      // armed behind it; otherwise the process holds the job open and the timer
      // later writes TIMEOUT over an already-COMPLETED review.
      clearTimeout(deadline);
    }
  },
  {
    connection: redisConnection,
    concurrency: 5,
    settings: { backoffStrategy: reviewBackoff },
  }
);

analysisWorker.on('ready', () => console.log(`👷 Multi-tenant Background worker fleet active.`));
