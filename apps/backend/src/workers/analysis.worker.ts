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
import { assessRisk } from '../services/security/risk-engine';
import { DiffFilterService } from '../services/diff-filter.service';
import { buildReviewContext } from '../services/context-builder';
import type { ReviewContext } from '../services/ai/context-prompt';
import { sortBySeverity } from '../services/ai/finding-taxonomy';
import { deduplicate } from '../services/ai/finding-dedup.service';
import {
  renderFindingListItem,
  renderInlineComment,
  severityTally,
} from '../services/ai/finding-format';
import { QuotaService } from '../services/quota.service';
import { PermanentJobError, isPermanentJobError } from '../errors/permanent-job.error';
import { advanceReview, markReviewTerminal, wasSuperseded } from './job-state';
import { ANALYSIS_QUEUE_NAME, REVIEW_TIMEOUT_MS } from '../utils/constants';

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
      installationId,
      isPrivate,
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

    try {
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
        return await prisma.analysisJob.update({ where: { id: jobId }, data: { status: 'COMPLETED' } });
      }

      // Filter out files specified in .aipr.yml ignore list
      const { filteredDiff, ignoredFiles, includedFiles } = DiffFilterService.filterDiff(rawDiff, repoConfig);

      if (ignoredFiles.length > 0) {
        console.log(`🛡️ Ignored ${ignoredFiles.length} files matching .aipr.yml patterns: ${ignoredFiles.join(', ')}`);
      }

      if (!filteredDiff || filteredDiff.trim().length < 5) {
        console.log(`💨 Diff empty after applying .aipr.yml ignore filters. Finishing early.`);
        SocketService.emitStatus(userId, jobId, `💨 All changed files matched ignore rules. No audit required.`, 'COMPLETED');
        return await prisma.analysisJob.update({ where: { id: jobId }, data: { status: 'COMPLETED' } });
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
      const securityScan = runSecurityProbes(repoConfig.security, filteredDiff);
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
        }));
        await assertNotSuperseded();

        if (context) {
          console.log(`🔎 Context: ${context.files.length} file(s), ${context.files.reduce((n, f) => n + f.content.length, 0)} chars`);
        } else {
          console.log(`🔎 Context: unavailable, reviewing diff only`);
        }
      }

      await advanceReview(jobId, userId, 'ANALYZING', `🧠 AI Dispatching to ${vault.provider} Models`);

      const aiDriver = AiProviderFactory.getProvider(vault.provider, rawApiKey);
      const rawSuggestions = await guard(
        aiDriver.analyzeCode(
          filteredDiff,
          promptGuidelines,
          context,
          { signal: abort.signal },
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
      const { findings: suggestions, report: risk } = assessRisk(mergedFindings);

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
            })),
            skipDuplicates: true,
          }),
        );
      }

      // Persist the findings now, but not as COMPLETED: comments still have to
      // be delivered, and a crash during delivery must not read as a finished
      // review. The final COMPLETED write happens after posting succeeds.
      await prisma.analysisJob.update({
        where: { id: jobId },
        data: {
          results: {
            suggestions,
            ignoredFiles,
            includedFiles,
            config: repoConfig,
            ruleChecks: ruleEvaluation.checks,
            securityChecks: securityScan.checks,
            risk,
          } as any,
        },
      });

      // 9. POST INLINE REVIEWS AND SUMMARY ON PULL REQUESTS
      // Comment posting reports instead of throwing, so a rejected comment
      // (wrong line, renamed file, stale SHA) must be counted and surfaced —
      // otherwise the user is told the review succeeded with zero comments.
      const commentFailures: string[] = [];
      let summaryPosted = true;

      if (eventType === 'PULL_REQUEST') {
        const prNum = parseInt(referenceId, 10);

        if (suggestions.length > 0) {
          console.log(`📬 Broadcasting inline review comments back to Pull Request #${referenceId}...`);

          // Last checkpoint before anything is written to the PR. Comments are
          // the only step with an effect the user cannot undo from here, so this
          // is where abandoning the attempt matters most.
          await assertNotSuperseded();

          await advanceReview(jobId, userId, 'POSTING', `📬 Injecting Inline Comments onto GitHub PR`);

          for (const suggestion of suggestions) {
            // The deadline can fire between comments; re-check cheaply so an
            // abandoned review stops touching the PR partway through delivery.
            if (superseded) await assertNotSuperseded();

            const result = await guard(ghService.createReviewComment(
              owner,
              repo,
              prNum,
              headSha,
              suggestion.filePath,
              suggestion.lineNumber,
              renderInlineComment(suggestion)
            ));

            if (result && result.ok === false) {
              commentFailures.push(
                `${suggestion.filePath}:${suggestion.lineNumber} — ${result.error ?? 'unknown error'}`
              );
            }
          }
        }

        // Inline comments are rejected whenever the model cites a line that is
        // not in the diff. The findings are still valid and already stored, so
        // publish them as a single fallback comment rather than losing them.
        const postedInline = suggestions.length - commentFailures.length;

        if (commentFailures.length > 0) {
          console.warn(
            `⚠️ ${commentFailures.length}/${suggestions.length} inline comments rejected for PR #${referenceId}. ` +
            `Falling back to a single consolidated comment.`,
          );
          SocketService.emitStatus(
            userId,
            jobId,
            `⚠️ ${commentFailures.length} comment(s) could not be placed inline — posting a consolidated summary instead.`,
            'POSTING',
          );
        }

        // Post top-level summary if enabled in config
        if (repoConfig.summarize && typeof ghService.createIssueComment === 'function') {
          const fallbackSection =
            commentFailures.length > 0
              ? `\n\n> ⚠️ **${commentFailures.length} of ${suggestions.length} findings could not be attached inline** (the cited lines are not part of this diff). They are listed below and saved in full in the AI PR Reviewer dashboard.`
              : '';

          const findingsSection =
            commentFailures.length > 0
              ? `\n\n## Findings\n\n${suggestions.map(renderFindingListItem).join('\n')}`
              : '';

          const summaryMarkdown = [
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
            ...(risk.verdict === 'BLOCK'
              ? [`> 🚫 **This review is blocked**: ${risk.reasons.join('; ')}.`]
              : []),
            `- **Comments Posted Inline**: ${postedInline}/${suggestions.length}${fallbackSection}`,
            '',
            '*Automated review powered by [AI PR Reviewer](https://reviewer.shehzaib.com)*',
            findingsSection,
          ].join('\n');

          const summaryResult = await guard(ghService.createIssueComment(owner, repo, prNum, summaryMarkdown));
          summaryPosted = !summaryResult || summaryResult.ok !== false;
        }
      }

      // Persist delivery outcome and mark the review finished. This is the
      // single terminal write, so a review can never read as COMPLETED while
      // its comments are still in flight.
      //
      // Re-checked immediately before: the deadline can fire during delivery, and
      // without this a review already written off as TIMEOUT would be overwritten
      // with a cheerful COMPLETED.
      await assertNotSuperseded();

      await prisma.analysisJob.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          results: {
            suggestions,
            ignoredFiles,
            includedFiles,
            config: repoConfig,
            ruleChecks: ruleEvaluation.checks,
            securityChecks: securityScan.checks,
            risk,
            commentFailures,
            summaryPosted,
          } as any,
        },
      });

      if (commentFailures.length > 0) {
        SocketService.emitStatus(
          userId,
          jobId,
          `⚠️ Review finished, but ${commentFailures.length} comment(s) could not be placed inline. See the PR summary for details.`,
          'COMPLETED',
          { suggestions },
        );
      }

      // 11. RECORD USAGE IN METERING LEDGER
      const resolvedInstallationRecordId = installationId || dbRepo.installationId;
      await QuotaService.incrementUsage(resolvedInstallationRecordId, Boolean(isPrivate ?? dbRepo.isPrivate));

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
        SocketService.emitStatus(userId, jobId, `⏭️ Skipped: ${message}`, 'SKIPPED');

        await prisma.analysisJob.update({
          where: { id: jobId },
          data: {
            status: 'SKIPPED',
            results: { reason: err.reason, error: message } as any,
          },
        });

        throw new UnrecoverableError(message);
      }

      // Transient: log and let BullMQ use the remaining attempts.
      console.error(`🚨 JOB FATALITY (attempt will retry): ${jobId} died:`, err);
      SocketService.emitStatus(userId, jobId, `🚨 Fatal Error Encountered: ${message}`, 'FAILED');

      await prisma.analysisJob.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          results: { error: message } as any,
        },
      });

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
  }
);

analysisWorker.on('ready', () => console.log(`👷 Multi-tenant Background worker fleet active.`));
