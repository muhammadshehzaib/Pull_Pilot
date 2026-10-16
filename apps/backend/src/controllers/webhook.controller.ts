import { Request, Response } from 'express';
import { analysisQueue } from '../config/queue';
import prisma from '../config/prisma';
import { QuotaService } from '../services/quota.service';
import { GitHubAppService } from '../services/github-app.service';
import { RepositoryContextCache } from '../services/repository-context-cache.service';

export class WebhookController {
  static async handleGitHubEvent(req: Request, res: Response) {
    const githubEventHeader = req.headers['x-github-event'] as string;
    const payload = req.body;

    console.log(`📡 Received Webhook Event: ${githubEventHeader} (Action: ${payload?.action || 'none'})`);

    // 1. Handle 'ping' events used by GitHub to test delivery
    if (githubEventHeader === 'ping') {
      return res.status(200).json({ message: 'pong' });
    }

    // 2. Handle GitHub App Installation events
    if (githubEventHeader === 'installation') {
      return await WebhookController.handleInstallationEvent(payload, res);
    }

    // 3. Handle GitHub App Installation Repositories (added/removed) events
    if (githubEventHeader === 'installation_repositories') {
      return await WebhookController.handleInstallationRepositoriesEvent(payload, res);
    }

    // 4. Handle PR review events (pull_request, etc.)
    //    Billing moved to Polar and arrives on /api/billing/webhook.
    try {
      const repoFullName = payload?.repository?.full_name;
      const githubRepoId = payload?.repository?.id;
      if (!repoFullName || !githubRepoId) {
        return res.status(400).json({ error: 'Invalid repository structure in payload' });
      }

      const githubInstallationId = payload.installation?.id ? BigInt(payload.installation.id) : null;

      // GitHub IDs are stable; names can change and are not a tenant boundary.
      const matchingRepos = await prisma.repository.findMany({
        where: {
          githubRepoId: BigInt(githubRepoId),
          isActive: true,
          ...(githubInstallationId
            ? { installation: { githubInstallationId } }
            : { installationId: null }),
        },
        include: { installation: true },
        take: 2,
      });
      if (matchingRepos.length > 1) {
        console.error(`Ambiguous repository ownership for GitHub repository ${githubRepoId}; refusing cross-tenant routing.`);
        return res.status(200).json({ status: 'SKIPPED', reason: 'ambiguous-repository-ownership' });
      }
      let dbRepo = matchingRepos[0] ?? null;

      // If repository not found directly, check if installation exists to link/activate it
      if (!dbRepo && githubInstallationId && prisma.installation?.findUnique) {
        const dbInstallation = await prisma.installation.findUnique({
          where: { githubInstallationId },
        });

        if (dbInstallation && dbInstallation.userId) {
          dbRepo = await prisma.repository.create({
            data: {
              userId: dbInstallation.userId,
              installationId: dbInstallation.id,
              githubRepoId: BigInt(payload.repository.id),
              fullName: repoFullName,
              isPrivate: Boolean(payload.repository?.private),
              isActive: true,
            },
            include: { installation: true },
          });
          console.log(`✨ Automatically registered repository ${repoFullName} for installation ${githubInstallationId}`);
        }
      }

      if (!dbRepo) {
        console.log(`⚠️ Skipping: Repo ${repoFullName} not active in system database.`);
        return res.status(200).json({ status: 'SKIPPED', reason: 'inactive-repository' });
      }

      let jobType: 'PULL_REQUEST' | 'PUSH' | null = null;
      let refId: string = '';

      // 5. Parse event types and filter allowed actions
      if (githubEventHeader === 'pull_request') {
        const allowedActions = ['opened', 'synchronize', 'reopened'];
        if (!allowedActions.includes(payload.action)) {
          return res.status(200).json({ status: 'SKIPPED', reason: `action-${payload.action}-ignored` });
        }
        jobType = 'PULL_REQUEST';
        refId = payload.pull_request?.number ? payload.pull_request.number.toString() : '';
      } else if (githubEventHeader === 'push') {
        jobType = 'PUSH';
        refId = payload.after || '';
      }

      if (!jobType) {
        return res.status(200).json({ status: 'SKIPPED', reason: 'unsupported-event-type' });
      }

      // 5a. Resolve the head SHA, and refuse the delivery if we cannot.
      //
      // The head SHA is the identity of a review. It is the column in
      // @@unique([repositoryId, eventType, referenceId, commitSha]) that makes
      // redelivery a no-op, and it is what the worker anchors the diff fetch to.
      // PostgreSQL treats NULLs as distinct inside a unique constraint, so a
      // payload without a resolvable SHA can never match an earlier row: every
      // redelivery would queue another review and spend the quota again. That
      // defeats the guarantee the index exists to provide.
      //
      // Declining is also the honest answer on review quality grounds — with no
      // head SHA there is no commit for the diff to be taken against, so the
      // "review" could not have been meaningful. Checked here, before the quota
      // gate, so a declined delivery leaves no trace beyond a SKIPPED row.
      const commitSha =
        jobType === 'PULL_REQUEST'
          ? payload.pull_request?.head?.sha ?? null
          : payload.after ?? null;

      if (!commitSha) {
        console.warn(
          `⚠️ Skipping review for ${repoFullName} ${jobType} ${refId}: payload carried no head commit SHA.`,
        );
        await prisma.analysisJob.create({
          data: {
            repositoryId: dbRepo.id,
            eventType: jobType,
            referenceId: refId,
            status: 'SKIPPED',
            results: {
              reason: 'missing-head-sha',
              details: 'Webhook payload did not include a resolvable head commit SHA, so the review could not be identified or anchored to a diff.',
            },
          },
        });
        return res.status(200).json({ status: 'SKIPPED', reason: 'missing-head-sha' });
      }

      const isPrivate = Boolean(payload.repository?.private);

      // Keep repository private flag updated if changed
      if (prisma.repository.update && typeof dbRepo.isPrivate === 'boolean' && dbRepo.isPrivate !== isPrivate) {
        try {
          await prisma.repository.update({
            where: { id: dbRepo.id },
            data: { isPrivate },
          });
        } catch {
          // ignore error if update not mocked/supported
        }
      }

      // 6. Enforce Free Tier Quota Limits
      const quotaCheck = await QuotaService.checkQuota(dbRepo.installationId, isPrivate, dbRepo.userId);
      if (!quotaCheck.allowed) {
        const existingReview = await prisma.analysisJob.findFirst({
          where: { repositoryId: dbRepo.id, eventType: jobType, referenceId: refId, commitSha },
          select: { id: true },
        });
        if (existingReview) {
          return res.status(200).json({ status: 'DUPLICATE', jobId: existingReview.id });
        }
        console.log(`🚫 Quota exceeded for ${repoFullName}: ${quotaCheck.reason}`);

        // Post friendly quota limit explanation directly on the PR
        if (jobType === 'PULL_REQUEST' && payload.installation?.id) {
          try {
            const ghService = await GitHubAppService.getInstallationService(payload.installation.id);
            const noticeComment = QuotaService.getQuotaExceededComment(
              quotaCheck.usage.current,
              quotaCheck.usage.limit || 50
            );
            const [owner, repoName] = repoFullName.split('/');
            await ghService.createIssueComment(owner, repoName, Number(refId), noticeComment);
          } catch (commentErr) {
            console.warn('Could not post quota notice comment on GitHub:', commentErr);
          }
        }

        // Record skipped job in DB
        await prisma.analysisJob.create({
          data: {
            repositoryId: dbRepo.id,
            eventType: jobType,
            referenceId: refId,
            status: 'SKIPPED',
            commitSha,
            results: { reason: 'quota-exceeded', details: quotaCheck.reason },
          },
        });

        return res.status(200).json({
          status: 'SKIPPED',
          reason: 'quota-exceeded',
          usage: quotaCheck.usage,
        });
      }

      // 7. Persist basic Analysis Job log in DB as QUEUED.
      // `commitSha` was resolved in 5a and is guaranteed non-null by this point,
      // which is what makes the insert below idempotent against redelivery.
      let newJob;
      try {
        newJob = await prisma.analysisJob.create({
          data: {
            repositoryId: dbRepo.id,
            eventType: jobType,
            referenceId: refId,
            commitSha,
            status: 'QUEUED',
          },
        });
      } catch (createErr) {
        // The unique index is the authority on what has already been reviewed.
        // If it rejects the insert, this exact (repo, event, ref, sha) has a job.
        const isDuplicate =
          (createErr as { code?: string })?.code === 'P2002' ||
          /unique|already exists/i.test((createErr as Error)?.message ?? '');

        if (isDuplicate) {
          console.log(`♻️  Duplicate webhook ignored: ${repoFullName} ${jobType} ${refId} @ ${commitSha.slice(0, 7)}`);
          // 200, not an error: GitHub retries anything non-2xx, which would
          // deliver the very duplicate we are trying to avoid.
          return res.status(200).json({
            status: 'DUPLICATE',
            message: 'This commit has already been queued for review.',
          });
        }
        throw createErr;
      }

      // Reserve only after the unique job insert so redelivered webhooks do not
      // spend another slot. The conditional ledger increment closes quota races.
      const reservation = await QuotaService.reserveReview(dbRepo.installationId, isPrivate, dbRepo.userId, newJob.id);
      if (!reservation.allowed) {
        await prisma.analysisJob.update({
          where: { id: newJob.id },
          data: { status: 'SKIPPED', results: { reason: 'quota-exceeded', details: reservation.reason } },
        });
        return res.status(200).json({ status: 'SKIPPED', reason: 'quota-exceeded', usage: reservation.usage });
      }

      // 8. Enqueue job into BullMQ
      await analysisQueue.add(`analyze-${jobType}-${refId}`, {
        jobId: newJob.id,
        repositoryId: dbRepo.id,
        userId: dbRepo.userId,
        fullName: repoFullName,
        eventType: jobType,
        referenceId: refId,
        githubInstallationId: payload.installation?.id ? String(payload.installation.id) : null,
        installationId: dbRepo.installationId,
        isPrivate,
        payloadSnapshot: {
          headSha: commitSha,
          baseSha: jobType === 'PULL_REQUEST' ? payload.pull_request?.base?.sha : payload.before,
        },
      }, { jobId: newJob.id });

      console.log(`✅ Job queued successfully. ID: ${newJob.id}`);
      return res.status(202).json({
        status: 'QUEUED',
        jobId: newJob.id,
        message: 'Analysis task distributed to processing fleet.',
      });
    } catch (err) {
      console.error('💥 Error processing webhook payload:', err);
      return res.status(500).json({ error: 'Internal processing error' });
    }
  }

  /**
   * Handles GitHub App installation lifecycle events.
   */
  private static async handleInstallationEvent(payload: any, res: Response) {
    const action = payload.action;
    const installation = payload.installation;

    if (!installation) {
      return res.status(400).json({ error: 'Missing installation payload' });
    }

    const githubInstallationId = BigInt(installation.id);
    const accountLogin = installation.account?.login || 'unknown';
    const accountType = installation.account?.type || 'User';
    const avatarUrl = installation.account?.avatar_url || null;

    if (action === 'created' && prisma.installation?.upsert) {
      await prisma.installation.upsert({
        where: { githubInstallationId },
        update: {
          accountLogin,
          accountType,
          avatarUrl,
          ...(payload.sender?.id ? { createdByGithubId: String(payload.sender.id) } : {}),
        },
        create: {
          githubInstallationId,
          accountLogin,
          accountType,
          avatarUrl,
          createdByGithubId: payload.sender?.id ? String(payload.sender.id) : null,
          plan: 'FREE',
        },
      });
      console.log(`🎉 New GitHub App installation registered: ${accountLogin} (ID: ${installation.id})`);
    } else if (action === 'deleted' && prisma.installation?.deleteMany) {
      // The installation -> repository relation is onDelete: SetNull, so deleting
      // the installation neither removes repositories nor their cached code.
      // Clear the cached context first, while the link still exists.
      if (prisma.repository?.findMany) {
        const repos = await prisma.repository.findMany({
          where: { installation: { githubInstallationId } },
          select: { id: true },
        });
        const cache = new RepositoryContextCache();
        await prisma.repository.updateMany({ where: { installation: { githubInstallationId } }, data: { isActive: false } });
        const { cancelDisconnectedReviews } = await import('../workers/review-recovery');
        for (const repo of repos) {
          await cancelDisconnectedReviews(repo.id);
          await cache.clearRepository(repo.id);
        }
      }
      await prisma.installation.deleteMany({
        where: { githubInstallationId },
      });
      console.log(`🗑️ GitHub App installation deleted: ${accountLogin} (ID: ${installation.id})`);
    }

    return res.status(200).json({ status: 'PROCESSED', action });
  }

  /**
   * Handles adding and removing repositories from a GitHub App installation.
   */
  private static async handleInstallationRepositoriesEvent(payload: any, res: Response) {
    const action = payload.action;
    const githubInstallationId = BigInt(payload.installation.id);

    if (!prisma.installation?.findUnique) {
      return res.status(200).json({ status: 'PROCESSED', action });
    }

    const dbInstallation = await prisma.installation.findUnique({
      where: { githubInstallationId },
    });

    if (!dbInstallation) {
      return res.status(200).json({ status: 'SKIPPED', reason: 'installation-not-found' });
    }

    if (action === 'added' && Array.isArray(payload.repositories_added)) {
      for (const repo of payload.repositories_added) {
        if (dbInstallation.userId) {
          const repoId = BigInt(repo.id);
          const existingRepo = await prisma.repository.findFirst({ where: { githubRepoId: repoId } });
          if (existingRepo && existingRepo.userId === dbInstallation.userId &&
              (!existingRepo.installationId || existingRepo.installationId === dbInstallation.id)) {
            await prisma.repository.update({
              where: { id: existingRepo.id },
              data: {
                userId: dbInstallation.userId,
                fullName: repo.full_name,
                isPrivate: Boolean(repo.private),
                isActive: true,
                installationId: dbInstallation.id,
                defaultBranch: repo.default_branch ?? null,
              },
            });
          } else if (existingRepo?.installationId === dbInstallation.id) {
            console.error(`Repository ${repo.full_name} is linked to installation ${dbInstallation.id} under another user; skipping ownership change.`);
          } else {
            await prisma.repository.create({
              data: {
                userId: dbInstallation.userId,
                installationId: dbInstallation.id,
                githubRepoId: repoId,
                fullName: repo.full_name,
                isPrivate: Boolean(repo.private),
                isActive: true,
                defaultBranch: repo.default_branch ?? null,
              },
            });
          }
        }
      }
    } else if (action === 'removed' && Array.isArray(payload.repositories_removed)) {
      const cache = new RepositoryContextCache();
      for (const repo of payload.repositories_removed) {
        if (prisma.repository?.updateMany) {
          // Removing a repository deletes the code we copied from it. Retention
          // is indefinite, so deactivation alone would keep those rows forever.
          const affected = await prisma.repository.findMany({
            where: { githubRepoId: BigInt(repo.id), installationId: dbInstallation.id },
            select: { id: true },
          });
          await prisma.repository.updateMany({
            where: { githubRepoId: BigInt(repo.id), installationId: dbInstallation.id },
            data: { isActive: false },
          });
          const { cancelDisconnectedReviews } = await import('../workers/review-recovery');
          for (const row of affected) {
            await cancelDisconnectedReviews(row.id);
            await cache.clearRepository(row.id);
          }
        }
      }
    }

    return res.status(200).json({ status: 'PROCESSED', action });
  }
}

