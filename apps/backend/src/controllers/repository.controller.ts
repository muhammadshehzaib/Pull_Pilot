import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { GitHubService } from '../services/github.service';
import { GitHubAppService } from '../services/github-app.service';
import { RepositoryContextCache } from '../services/repository-context-cache.service';
import { analysisQueue } from '../config/queue';
import { BACKEND_URL } from '../utils/constants';
import { QuotaService } from '../services/quota.service';
import { paginationMeta, parsePagination } from '../utils/pagination';
import { RepositoryAccessError } from '../errors/repository-access.error';

async function getGitHub(installationId?: string | number | null): Promise<GitHubService> {
  return await GitHubAppService.getInstallationService(installationId);
}

export class RepositoryController {
  /**
   * Lists the user's repositories, newest first, paged by ?page= / ?limit=.
   *
   * `activeCount` is returned alongside `pagination.total` because the UI's
   * "Connected (N)" label counts only active repos while `pagination.total`
   * counts every row on the page query — including disconnected ones, which
   * are still listed so a user can reconnect them.
   */
  static async list(req: Request, res: Response) {
    const { page, limit, skip } = parsePagination(req.query);
    const where = { userId: req.auth!.userId };

    const [repos, total, activeCount] = await Promise.all([
      prisma.repository.findMany({
        where,
        include: { installation: true },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.repository.count({ where }),
      prisma.repository.count({ where: { ...where, isActive: true } }),
    ]);

    // BigInt is not JSON-serializable — coerce to string
    return res.json({
      repositories: repos.map((r) => ({
        ...r,
        githubRepoId: r.githubRepoId.toString(),
        installation: r.installation
          ? {
              ...r.installation,
              githubInstallationId: r.installation.githubInstallationId.toString(),
            }
          : null,
      })),
      pagination: paginationMeta(page, limit, total),
      activeCount,
    });
  }

  static async register(req: Request, res: Response) {
    const { fullName } = req.body ?? {};
    if (typeof fullName !== 'string' || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\/[a-zA-Z0-9_.-]+$/.test(fullName) || /\/(?:\.|\.\.)$/.test(fullName)) {
      return res.status(400).json({ error: 'fullName must be in "owner/repo" form' });
    }

    const [owner, repo] = fullName.split('/');
    const existing = await prisma.repository.findFirst({
      where: { userId: req.auth!.userId, fullName },
      include: { installation: true },
    });
    if (existing?.isActive) {
      return res.status(409).json({ error: 'Repository already registered' });
    }

    try {
      if (existing?.installation && existing.installation.userId !== req.auth!.userId) {
        throw new RepositoryAccessError();
      }
      const gh = await getGitHub(existing?.installation?.githubInstallationId?.toString());
      const ghRepo = await gh.getRepoForUser(owner, repo, req.auth!.githubId, {
        expectedRepoId: existing?.githubRepoId.toString(),
        requireMembership: existing?.isPrivate,
      });
      const claimedRepo = await prisma.repository.findFirst({
        where: { githubRepoId: BigInt(ghRepo.id) },
        select: { id: true, userId: true },
      });
      if (claimedRepo && claimedRepo.id !== existing?.id && claimedRepo.userId !== req.auth!.userId) {
        return res.status(409).json({ error: 'Repository is already connected to another account' });
      }
      const webhookUrl = `${BACKEND_URL}/api/webhooks/github`;

      let hookId: string | null = null;
      try {
        hookId = await gh.createWebhook(owner, repo, webhookUrl, process.env.GITHUB_WEBHOOK_SECRET);
      } catch (hookErr) {
        const msg = (hookErr as Error).message || '';
        const unreachableUrl =
          /isn't reachable over the public internet/i.test(msg) || webhookUrl.includes('localhost');
        if (!unreachableUrl) throw hookErr;
        console.warn(
          `⚠️ Webhook not installed for ${fullName} (${msg}). Connected for manual audits only.`
        );
      }

      const updateData: any = {
        githubRepoId: BigInt(ghRepo.id),
        webhookId: hookId,
        isActive: true,
      };
      if (typeof ghRepo.private === 'boolean') {
        updateData.isPrivate = ghRepo.private;
      }
      if (ghRepo.default_branch) {
        updateData.defaultBranch = ghRepo.default_branch;
      }

      const createData: any = {
        userId: req.auth!.userId,
        githubRepoId: BigInt(ghRepo.id),
        fullName,
        webhookId: hookId,
        isActive: true,
      };
      if (typeof ghRepo.private === 'boolean') {
        createData.isPrivate = ghRepo.private;
      }
      if (ghRepo.default_branch) {
        createData.defaultBranch = ghRepo.default_branch;
      }

      const dbRepo = existing
        ? await prisma.repository.update({
            where: { id: existing.id },
            data: updateData,
          })
        : await prisma.repository.create({
            data: createData,
          });

      return res.status(existing ? 200 : 201).json({
        repository: { ...dbRepo, githubRepoId: dbRepo.githubRepoId.toString() },
        ...(hookId
          ? {}
          : {
              warning:
                'Webhook not installed: the backend URL is not reachable from GitHub. Use the Audit button to run reviews manually.',
            }),
      });
    } catch (err) {
      if (err instanceof RepositoryAccessError) {
        return res.status(err.status).json({ error: err.message });
      }
      console.error('🔴 Repo registration failure:', err);
      return res.status(500).json({ error: 'Could not connect repository' });
    }
  }

  static async deactivate(req: Request, res: Response) {
    const id = String(req.params.id);
    const repo = await prisma.repository.findFirst({
      where: { id, userId: req.auth!.userId },
      include: { installation: true },
    });
    if (!repo) return res.status(404).json({ error: 'Repository not found' });

    if (repo.webhookId) {
      try {
        const [owner, name] = repo.fullName.split('/');
        const gh = await getGitHub(repo.installation?.githubInstallationId?.toString());
        await gh.deleteWebhook(owner, name, Number(repo.webhookId));
      } catch (err) {
        console.warn('⚠️ Failed to delete GitHub webhook — proceeding with DB deactivation:', err);
      }
    }

    await prisma.repository.update({
      where: { id: repo.id },
      data: { isActive: false, webhookId: null },
    });

    // Disconnecting a repository is the promise to delete the code we copied
    // from it. Deactivating alone leaves every cached file in the database
    // forever under indefinite retention, so drop the cached context here.
    await new RepositoryContextCache().clearRepository(repo.id);
    const { clearRepositoryHistory } = await import('../workers/historical-maintenance');
    await clearRepositoryHistory(repo.id);

    return res.json({ status: 'OK' });
  }

  static async triggerAnalysis(req: Request, res: Response) {
    const id = String(req.params.id);
    const { pullNumber, headSha, baseSha, branch } = req.body ?? {};

    const repo = await prisma.repository.findFirst({
      where: { id, userId: req.auth!.userId, isActive: true },
      include: { installation: true },
    });
    if (!repo) return res.status(404).json({ error: 'Repository not found or inactive' });

    const [owner, name] = repo.fullName.split('/');
    // A bare audit request (no PR, no explicit SHAs, no branch) falls back to
    // the repository's stored default branch rather than being rejected.
    if (!pullNumber && !(headSha && baseSha) && !branch && !repo.defaultBranch) {
      return res.status(400).json({
        error: 'Either pullNumber, (headSha and baseSha), or branch must be provided',
      });
    }

    let eventType: 'PULL_REQUEST' | 'PUSH';
    let referenceId: string;
    let resolvedHead: string;
    let resolvedBase: string;

    try {
      const gh = await getGitHub(repo.installation?.githubInstallationId?.toString());
      if (pullNumber) {
        const pr = await gh.getPullRequest(owner, name, Number(pullNumber));
        eventType = 'PULL_REQUEST';
        referenceId = String(pullNumber);
        resolvedHead = pr.head.sha;
        resolvedBase = pr.base.sha;
      } else if (headSha && baseSha) {
        eventType = 'PUSH';
        referenceId = headSha;
        resolvedHead = headSha;
        resolvedBase = baseSha;
      } else {
        // Audit branch: the user-specified branch, else the stored default
        // branch, else let GitHub resolve it (main/master fallback).
        const commitInfo = await gh.getLatestCommitWithParent(
          owner,
          name,
          branch || repo.defaultBranch || undefined,
        );
        eventType = 'PUSH';
        referenceId = commitInfo.headSha;
        resolvedHead = commitInfo.headSha;
        resolvedBase = commitInfo.baseSha;
      }
    } catch (err) {
      return res.status(502).json({ error: `GitHub lookup failed: ${(err as Error).message}` });
    }

    const job = await prisma.analysisJob.create({
      data: {
        repositoryId: repo.id,
        eventType,
        referenceId,
        // Manual reviews are deliberate, so this path always re-reviews. The
        // unique index ignores NULLs, so these never collide with webhook rows.
        commitSha: null,
        status: 'QUEUED',
      },
    });

    const reservation = await QuotaService.reserveReview(repo.installationId, repo.isPrivate, repo.userId);
    if (!reservation.allowed) {
      await prisma.analysisJob.update({
        where: { id: job.id },
        data: { status: 'SKIPPED', results: { reason: 'quota-exceeded', details: reservation.reason } },
      });
      return res.status(429).json({ error: reservation.reason, usage: reservation.usage });
    }

    await analysisQueue.add(`manual-${eventType}-${referenceId}`, {
      jobId: job.id,
      repositoryId: repo.id,
      userId: repo.userId,
      fullName: repo.fullName,
      eventType,
      referenceId,
      githubInstallationId: repo.installation?.githubInstallationId?.toString() || null,
      installationId: repo.installationId,
      isPrivate: repo.isPrivate,
      payloadSnapshot: { headSha: resolvedHead, baseSha: resolvedBase },
    });

    return res.status(202).json({ jobId: job.id, status: 'QUEUED' });
  }

  static async updateHistoricalSettings(req: Request, res: Response) {
    const id = String(req.params.id);
    const { enabled } = req.body ?? {};

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }

    const repo = await prisma.repository.findFirst({
      where: { id, userId: req.auth!.userId },
    });

    if (!repo) {
      return res.status(404).json({ error: 'Repository not found or access denied' });
    }

    const updated = await prisma.repository.update({
      where: { id: repo.id },
      data: { historicalIntelligenceEnabled: enabled },
      select: { id: true, historicalIntelligenceEnabled: true },
    });

    return res.json({
      repositoryId: updated.id,
      historicalIntelligenceEnabled: updated.historicalIntelligenceEnabled,
    });
  }

  static async getHistoricalSettings(req: Request, res: Response) {
    const id = String(req.params.id);

    const repo = await prisma.repository.findFirst({
      where: { id, userId: req.auth!.userId },
      select: { id: true, historicalIntelligenceEnabled: true },
    });

    if (!repo) {
      return res.status(404).json({ error: 'Repository not found or access denied' });
    }

    return res.json({
      repositoryId: repo.id,
      historicalIntelligenceEnabled: repo.historicalIntelligenceEnabled,
    });
  }

  static async getHistoricalInsights(req: Request, res: Response) {
    const id = String(req.params.id);

    const repo = await prisma.repository.findFirst({
      where: { id, userId: req.auth!.userId },
    });

    if (!repo) {
      return res.status(404).json({ error: 'Repository not found or access denied' });
    }

    try {
      const { getRepositoryInsights } = await import('../services/historical/aggregation.service');
      const insights = await getRepositoryInsights(repo.id, {
        forceRefresh: req.query.refresh === 'true',
      });
      return res.json(insights);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }
}
