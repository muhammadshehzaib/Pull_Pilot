import { Worker, Job, UnrecoverableError } from 'bullmq';
import { redisConnection } from '../config/redis';
import { ANALYSIS_QUEUE_NAME } from '../config/queue';
import prisma from '../config/prisma';
import { EncryptionService } from '../services/encryption.service';
import { GitHubAppService } from '../services/github-app.service';
import { AiProviderFactory } from '../services/ai/ai-factory';
import { SocketService } from '../config/socket';
import { ConfigService } from '../services/config.service';
import { DiffFilterService } from '../services/diff-filter.service';
import { sortBySeverity } from '../services/ai/finding-taxonomy';
import { QuotaService } from '../services/quota.service';
import { PermanentJobError, isPermanentJobError } from '../errors/permanent-job.error';

export const analysisWorker = new Worker(
  ANALYSIS_QUEUE_NAME,
  async (job: Job) => {
    console.log(`\nâš™ï¸  WORKER: Awakening for Job ${job.id}...`);

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

    try {
      // 1. Update state to RUNNING
      await prisma.analysisJob.update({
        where: { id: jobId },
        data: { status: 'POSTING' },
      });

      SocketService.emitStatus(userId, jobId, 'ðŸš€ Worker Active: Analysis Cycle Commenced', 'POSTING');

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
      console.log(`ðŸ”‘ Vault Detected: Using user preference [${vault.provider}] engine.`);
      SocketService.emitStatus(userId, jobId, `ðŸ” Unlocking Security Vault [Provider: ${vault.provider}]`, 'POSTING');

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
      SocketService.emitStatus(userId, jobId, `âš™ï¸ Inspecting repository rules (.aipr.yml)`, 'POSTING');
      const repoConfig = await ConfigService.fetchRepoConfig(ghService, owner, repo, headSha);

      // 6. FETCH & FILTER RAW DIFF STREAM
      SocketService.emitStatus(userId, jobId, `ðŸ“¡ Fetching & Filtering Diff Stream`, 'POSTING');
      const rawDiff = await ghService.fetchDiff(owner, repo, baseSha, headSha);

      if (!rawDiff || rawDiff.length < 5) {
        console.log(`ðŸ’¨ Diff empty or too small. Finishing early.`);
        return await prisma.analysisJob.update({ where: { id: jobId }, data: { status: 'COMPLETED' } });
      }

      // Filter out files specified in .aipr.yml ignore list
      const { filteredDiff, ignoredFiles, includedFiles } = DiffFilterService.filterDiff(rawDiff, repoConfig);

      if (ignoredFiles.length > 0) {
        console.log(`ðŸ›¡ï¸ Ignored ${ignoredFiles.length} files matching .aipr.yml patterns: ${ignoredFiles.join(', ')}`);
      }

      if (!filteredDiff || filteredDiff.trim().length < 5) {
        console.log(`ðŸ’¨ Diff empty after applying .aipr.yml ignore filters. Finishing early.`);
        SocketService.emitStatus(userId, jobId, `ðŸ’¨ All changed files matched ignore rules. No audit required.`, 'COMPLETED');
        return await prisma.analysisJob.update({ where: { id: jobId }, data: { status: 'COMPLETED' } });
      }

      // 7. ENGAGE AI ENGINE VIA FACTORY
      console.log(`ðŸ§  Contacting ${vault.provider} for Analysis Strategy...`);
      SocketService.emitStatus(userId, jobId, `ðŸ§  AI Dispatching to ${vault.provider} Models`, 'POSTING');

      const aiDriver = AiProviderFactory.getProvider(vault.provider, rawApiKey);
      const rawSuggestions = await aiDriver.analyzeCode(filteredDiff, repoConfig.guidelines);

      // 8. FILTER SUGGESTIONS BY MIN_SEVERITY & SORT MOST SEVERE FIRST
      const suggestions = sortBySeverity(
        rawSuggestions.filter((s) => DiffFilterService.isSeverityMet(s.priority, repoConfig.min_severity)),
      );

      console.log(`ðŸŽ¯ AI Analysis Finished! Found ${rawSuggestions.length} total, ${suggestions.length} meeting ${repoConfig.min_severity} severity threshold.`);
      SocketService.emitStatus(userId, jobId, `ðŸŽ¯ Scan Complete: ${suggestions.length} items flagged`, 'POSTING');

      // 9. POST SUGGESTIONS TO GITHUB & SAVE TO DB
      await prisma.analysisJob.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          results: {
            suggestions,
            ignoredFiles,
            includedFiles,
            config: repoConfig,
          } as any,
        },
      });

      // 10. POST INLINE REVIEWS AND SUMMARY ON PULL REQUESTS
      // Comment posting reports instead of throwing, so a rejected comment
      // (wrong line, renamed file, stale SHA) must be counted and surfaced â€”
      // otherwise the user is told the review succeeded with zero comments.
      const commentFailures: string[] = [];
      let summaryPosted = true;

      if (eventType === 'PULL_REQUEST') {
        const prNum = parseInt(referenceId, 10);

        if (suggestions.length > 0) {
          console.log(`ðŸ“¬ Broadcasting inline review comments back to Pull Request #${referenceId}...`);
          SocketService.emitStatus(userId, jobId, `ðŸ“¬ Injecting Inline Comments onto GitHub PR`, 'POSTING');

          for (const suggestion of suggestions) {
            const priorityBadge = suggestion.priority ? `[${suggestion.priority}] ` : '';
            const commentBody = `### ðŸ¤– AI Code Review: ${priorityBadge}${suggestion.agentType}\n**Issue:** ${suggestion.issue}\n\n\`\`\`\n${suggestion.suggestion}\n\`\`\``;

            const result = await ghService.createReviewComment(
              owner,
              repo,
              prNum,
              headSha,
              suggestion.filePath,
              suggestion.lineNumber,
              commentBody
            );

            if (result && result.ok === false) {
              commentFailures.push(
                `${suggestion.filePath}:${suggestion.lineNumber} â€” ${result.error ?? 'unknown error'}`
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
            `âš ï¸ ${commentFailures.length}/${suggestions.length} inline comments rejected for PR #${referenceId}. ` +
            `Falling back to a single consolidated comment.`,
          );
          SocketService.emitStatus(
            userId,
            jobId,
            `âš ï¸ ${commentFailures.length} comment(s) could not be placed inline â€” posting a consolidated summary instead.`,
            'POSTING',
          );
        }

        // Post top-level summary if enabled in config
        if (repoConfig.summarize && typeof ghService.createIssueComment === 'function') {
          const fallbackSection =
            commentFailures.length > 0
              ? `\n\n> âš ï¸ **${commentFailures.length} of ${suggestions.length} findings could not be attached inline** (the cited lines are not part of this diff). They are listed below and saved in full in the AI PR Reviewer dashboard.`
              : '';

          const findingsSection =
            commentFailures.length > 0
              ? `\n\n## Findings\n\n${suggestions
                  .map(
                    (s, i) =>
                      `${i + 1}. **[${s.priority}] ${s.agentType}** \`${s.filePath}:${s.lineNumber}\`\n   - **Issue:** ${s.issue}\n   - **Suggestion:** ${s.suggestion}`,
                  )
                  .join('\n')}`
              : '';

          const summaryMarkdown = `## ðŸ¤– AI PR Review Summary\n\n- **Status**: Audit completed\n- **Findings**: ${suggestions.length} actionable items flagged (min severity: \`${repoConfig.min_severity}\`)\n- **Files Reviewed**: ${includedFiles.length} files (${ignoredFiles.length} ignored via \`.aipr.yml\`)\n- **Comments Posted Inline**: ${postedInline}/${suggestions.length}${fallbackSection}\n\n*Automated review powered by [AI PR Reviewer](https://reviewer.shehzaib.com)*${findingsSection}`;

          const summaryResult = await ghService.createIssueComment(owner, repo, prNum, summaryMarkdown);
          summaryPosted = !summaryResult || summaryResult.ok !== false;
        }
      }

      // Persist delivery outcome so the dashboard can explain an empty PR.
      if (commentFailures.length > 0 || !summaryPosted) {
        await prisma.analysisJob.update({
          where: { id: jobId },
          data: {
            results: {
              suggestions,
              ignoredFiles,
              includedFiles,
              config: repoConfig,
              commentFailures,
              summaryPosted,
            } as any,
          },
        });
      }

      if (commentFailures.length > 0) {
        SocketService.emitStatus(
          userId,
          jobId,
          `âš ï¸ Review finished, but ${commentFailures.length} comment(s) could not be placed inline. See the PR summary for details.`,
          'COMPLETED',
          { suggestions },
        );
      }

      // 11. RECORD USAGE IN METERING LEDGER
      const resolvedInstallationRecordId = installationId || dbRepo.installationId;
      await QuotaService.incrementUsage(resolvedInstallationRecordId, Boolean(isPrivate ?? dbRepo.isPrivate));

      console.log(`ðŸ Job Cycle ${jobId} gracefully exited with 100% success.\n`);
      SocketService.emitStatus(userId, jobId, `âœ… All Analysis Finalized. Results fully loaded.`, 'COMPLETED', { suggestions });

      return { status: 'success', findingCount: suggestions.length };
    } catch (err) {
      const message = (err as Error).message;
      const permanent = isPermanentJobError(err);

      // A permanent failure is the user's to fix. SKIPPED reads as "waiting on
      // you" rather than "broken", and UnrecoverableError stops BullMQ replaying
      // a job that cannot succeed. Logged once, not once per attempt.
      if (permanent) {
        console.warn(`â­ï¸  JOB SKIPPED (needs user action): ${jobId} â€” ${message}`);
        SocketService.emitStatus(userId, jobId, `â­ï¸ Skipped: ${message}`, 'SKIPPED');

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
      console.error(`ðŸš¨ JOB FATALITY (attempt will retry): ${jobId} died:`, err);
      SocketService.emitStatus(userId, jobId, `ðŸš¨ Fatal Error Encountered: ${message}`, 'FAILED');

      await prisma.analysisJob.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          results: { error: message } as any,
        },
      });

      throw err;
    }
  },
  {
    connection: redisConnection,
    concurrency: 5,
  }
);

analysisWorker.on('ready', () => console.log(`ðŸ‘· Multi-tenant Background worker fleet active.`));
