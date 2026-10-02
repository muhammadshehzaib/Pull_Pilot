import { Request, Response } from 'express';
import { analysisQueue } from '../config/queue';
import prisma from '../config/prisma';
import { QuotaService } from '../services/quota.service';
import { GitHubAppService } from '../services/github-app.service';
import { MarketplaceService } from '../services/marketplace.service';

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

    // 4. Handle GitHub Marketplace Billing events
    if (githubEventHeader === 'marketplace_purchase') {
      return await WebhookController.handleMarketplaceEvent(payload, res);
    }

    try {
      const repoFullName = payload?.repository?.full_name;
      if (!repoFullName) {
        return res.status(400).json({ error: 'Invalid repository structure in payload' });
      }

      // 4. Verify system has this repository registered or resolve via installation
      let dbRepo = await prisma.repository.findFirst({
        where: { fullName: repoFullName, isActive: true },
        include: { installation: true },
      });

      const githubInstallationId = payload.installation?.id ? BigInt(payload.installation.id) : null;

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
      const quotaCheck = await QuotaService.checkQuota(dbRepo.installationId, isPrivate);
      if (!quotaCheck.allowed) {
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
            results: { reason: 'quota-exceeded', details: quotaCheck.reason },
          },
        });

        return res.status(200).json({
          status: 'SKIPPED',
          reason: 'quota-exceeded',
          usage: quotaCheck.usage,
        });
      }

      // 7. Persist basic Analysis Job log in DB as QUEUED
      // The head SHA is the identity of this review: GitHub may redeliver the same
      // webhook any number of times, and a new commit on the same PR is a
      // genuinely new review. Persisting it makes that distinction possible.
      const commitSha =
        jobType === 'PULL_REQUEST'
          ? payload.pull_request?.head?.sha ?? null
          : payload.after ?? null;

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

        if (isDuplicate && commitSha) {
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
          headSha: commitSha ?? undefined,
          baseSha: jobType === 'PULL_REQUEST' ? payload.pull_request?.base?.sha : payload.before,
        },
      });

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
        update: { accountLogin, accountType, avatarUrl },
        create: {
          githubInstallationId,
          accountLogin,
          accountType,
          avatarUrl,
          plan: 'FREE',
        },
      });
      console.log(`🎉 New GitHub App installation registered: ${accountLogin} (ID: ${installation.id})`);
    } else if (action === 'deleted' && prisma.installation?.deleteMany) {
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
        if (dbInstallation.userId && prisma.repository?.upsert) {
          await prisma.repository.upsert({
            where: { id: `repo-github-${repo.id}` },
            update: {
              fullName: repo.full_name,
              isPrivate: Boolean(repo.private),
              isActive: true,
              installationId: dbInstallation.id,
            },
            create: {
              id: `repo-github-${repo.id}`,
              userId: dbInstallation.userId,
              installationId: dbInstallation.id,
              githubRepoId: BigInt(repo.id),
              fullName: repo.full_name,
              isPrivate: Boolean(repo.private),
              isActive: true,
            },
          });
        }
      }
    } else if (action === 'removed' && Array.isArray(payload.repositories_removed)) {
      for (const repo of payload.repositories_removed) {
        if (prisma.repository?.updateMany) {
          await prisma.repository.updateMany({
            where: { githubRepoId: BigInt(repo.id) },
            data: { isActive: false },
          });
        }
      }
    }

    return res.status(200).json({ status: 'PROCESSED', action });
  }

  /**
   * Handles GitHub Marketplace purchase, change, and cancellation webhook events.
   */
  private static async handleMarketplaceEvent(payload: any, res: Response) {
    try {
      const result = await MarketplaceService.handleMarketplaceEvent(payload);
      return res.status(200).json(result);
    } catch (err: any) {
      console.error('💥 Error processing marketplace_purchase payload:', err);
      return res.status(500).json({ error: (err as Error).message });
    }
  }
}

