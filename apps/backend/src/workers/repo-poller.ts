import prisma from '../config/prisma';
import { redisConnection } from '../config/redis';
import { analysisQueue } from '../config/queue';
import { GitHubService } from '../services/github.service';
import { GitHubAppService } from '../services/github-app.service';

const POLL_INTERVAL_MS = parseInt(process.env.REPO_POLL_INTERVAL_MS || '60000', 10);
const POLL_ENABLED = process.env.REPO_POLL_ENABLED !== 'false';

type PolledRepo = {
  id: string;
  fullName: string;
  isPrivate: boolean;
  installationId: string | null;
  installation: { githubInstallationId: bigint } | null;
  lastScannedSha: string | null;
  user: { id: string; username: string };
};

/**
 * Local-dev substitute for GitHub webhooks. Repos connected without a webhook
 * (GitHub refuses localhost BACKEND_URLs, or the bot lacks admin on a
 * third-party repo) are polled for:
 *   1. new commits on the default branch — reviewed as a PUSH range since the
 *      last seen head (the first sighting only records a baseline), and
 *   2. fresh commits on open PRs authored by the connecting user — reviewed as
 *      PULL_REQUEST jobs, which also post inline comments back to GitHub.
 */
export async function pollRepositoriesOnce(gh?: GitHubService) {
  const token = process.env.GITHUB_ACCESS_TOKEN;
  const hasApp = Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY);
  if (!token && !gh && !hasApp) return;

  const repos: PolledRepo[] = await prisma.repository.findMany({
    where: { isActive: true, webhookId: null },
    include: {
      user: { select: { id: true, username: true } },
      installation: { select: { githubInstallationId: true } },
    },
  });

  for (const repo of repos) {
    const [owner, name] = repo.fullName.split('/');
    try {
      const github =
        gh ??
        (await GitHubAppService.getInstallationService(
          repo.installation?.githubInstallationId?.toString()
        ));

      // 1. Default branch: review anything pushed since the last seen head.
      const head = await github.getLatestCommitSha(owner, name);
      if (head && head !== repo.lastScannedSha) {
        if (repo.lastScannedSha) {
          await queueReview(repo, 'PUSH', head, {
            headSha: head,
            baseSha: repo.lastScannedSha,
          });
        }
        await prisma.repository.update({
          where: { id: repo.id },
          data: { lastScannedSha: head },
        });
      }

      // 2. Open PRs by the connected user: review each new head SHA once.
      const pulls = await github.listOpenPullRequests(owner, name);
      for (const pr of pulls) {
        if (pr.user?.login?.toLowerCase() !== repo.user.username.toLowerCase()) continue;
        const seenKey = `pr-scanned:${repo.id}:${pr.number}:${pr.head.sha}`;
        if (await redisConnection.get(seenKey)) continue;
        await queueReview(repo, 'PULL_REQUEST', String(pr.number), {
          headSha: pr.head.sha,
          baseSha: pr.base.sha,
        });
        await redisConnection.set(seenKey, '1');
      }
    } catch (err) {
      console.warn(`⚠️ Poll failed for ${repo.fullName}: ${(err as Error).message}`);
    }
  }
}

async function queueReview(
  repo: PolledRepo,
  eventType: 'PUSH' | 'PULL_REQUEST',
  referenceId: string,
  payloadSnapshot: { headSha: string; baseSha: string },
) {
  // The poller can observe the same head SHA twice (a webhook arriving between
  // two poll ticks, or a page boundary straddling a push). Persist the SHA and
  // let the unique index drop the repeat instead of double-reviewing.
  const job = await prisma.analysisJob.create({
    data: {
      repositoryId: repo.id,
      eventType,
      referenceId,
      commitSha: payloadSnapshot.headSha,
      status: 'QUEUED',
    },
  }).catch((err: unknown) => {
    const isDuplicate =
      (err as { code?: string })?.code === 'P2002' ||
      /unique|already exists/i.test((err as Error)?.message ?? '');
    if (isDuplicate) return null;
    throw err;
  });

  if (!job) {
    console.log(`♻️  Poller skipped ${eventType} ${referenceId} for ${repo.fullName} — already reviewed at ${payloadSnapshot.headSha.slice(0, 7)}`);
    return;
  }

  await analysisQueue.add(`poll-${eventType}-${referenceId}`, {
    jobId: job.id,
    repositoryId: repo.id,
    userId: repo.user.id,
    fullName: repo.fullName,
    eventType,
    referenceId,
    githubInstallationId: repo.installation?.githubInstallationId?.toString() || null,
    installationId: repo.installationId,
    isPrivate: repo.isPrivate,
    payloadSnapshot,
  });

  console.log(`🛰️ Poller queued ${eventType} review for ${repo.fullName} (${referenceId})`);
}

let polling = false;

export function startRepoPoller() {
  if (!POLL_ENABLED) {
    console.log('🛰️ Repo poller disabled (REPO_POLL_ENABLED=false).');
    return;
  }

  const tick = async () => {
    if (polling) return; // don't overlap slow polls
    polling = true;
    try {
      await pollRepositoriesOnce();
    } finally {
      polling = false;
    }
  };

  setInterval(tick, POLL_INTERVAL_MS).unref();
  void tick();
  console.log(
    `🛰️ Repo poller active (every ${Math.round(POLL_INTERVAL_MS / 1000)}s): webhook-less repos are reviewed on new commits and PRs.`,
  );
}
