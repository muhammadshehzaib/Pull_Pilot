import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { GitHubService } from '../services/github.service';
import { GitHubAppService } from '../services/github-app.service';
import { RepositoryContextCache } from '../services/repository-context-cache.service';
import { analysisQueue } from '../config/queue';
import { BACKEND_URL } from '../utils/constants';

async function getGitHub(installationId?: string | number | null): Promise<GitHubService> {
  return await GitHubAppService.getInstallationService(installationId);
}

export class RepositoryController {
  static async list(req: Request, res: Response) {
    const repos = await prisma.repository.findMany({
      where: { userId: req.auth!.userId },
      include: { installation: true },
      orderBy: { createdAt: 'desc' },
    });
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
    });
  }

  static async register(req: Request, res: Response) {
    const { fullName } = req.body ?? {};
    if (!fullName || typeof fullName !== 'string' || !fullName.includes('/')) {
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
      const gh = await getGitHub(existing?.installation?.githubInstallationId?.toString());
      const ghRepo = await gh.getRepo(owner, repo);
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
      console.error('🔴 Repo registration failure:', err);
      return res.status(500).json({ error: (err as Error).message });
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
}
