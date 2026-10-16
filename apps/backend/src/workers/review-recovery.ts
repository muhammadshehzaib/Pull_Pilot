import type { Job } from 'bullmq';
import prisma from '../config/prisma';
import { analysisQueue } from '../config/queue';
import { IN_PROGRESS_REVIEW_STATUSES, markReviewTerminal } from './job-state';
import { REVIEW_TIMEOUT_MS } from '../utils/constants';

export const RECOVERY_INTERVAL_MS = 60_000;
export const ABANDONED_REVIEW_GRACE_MS = Math.max(REVIEW_TIMEOUT_MS, 60_000) + 120_000;
const BATCH_SIZE = 100;
const LIVE_AND_TERMINAL_QUEUE_STATES = ['active', 'wait', 'paused', 'delayed', 'prioritized', 'waiting-children', 'failed', 'completed'] as const;

async function queueRead<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Queue recovery read unavailable')), 3000);
    })]);
  } finally { clearTimeout(timer); }
}

/** Legacy queue IDs were numeric and not stored in PostgreSQL. Never infer
 * absence from a truncated listing; found jobs can still be adopted safely. */
async function legacyQueueSnapshot() {
  const before = await queueRead(analysisQueue.getJobCounts(...LIVE_AND_TERMINAL_QUEUE_STATES));
  const jobs = await queueRead(analysisQueue.getJobs([...LIVE_AND_TERMINAL_QUEUE_STATES], 0, 1000));
  const after = await queueRead(analysisQueue.getJobCounts(...LIVE_AND_TERMINAL_QUEUE_STATES));
  // A filled 1001-entry range proves truncation even if counts happened to
  // shrink again between reads. Conservatively require a small complete list.
  return { jobs, complete: jobs.length <= 1000 && Object.values(before).every(n => n <= 1000) && Object.values(after).every(n => n <= 1000) };
}

/** Bounded, keyset-paginated reconciliation; no GitHub writes or review replay. */
export async function recoverReviewsOnce(afterId?: string) {
  const rows = await prisma.analysisJob.findMany({
    where: { status: { in: [...IN_PROGRESS_REVIEW_STATUSES] }, ...(afterId ? { id: { gt: afterId } } : {}) },
    include: { repository: { select: { userId: true, isActive: true } } }, orderBy: { id: 'asc' }, take: BATCH_SIZE,
  });
  let changed = 0, queueUnavailable = false;
  let legacy: Awaited<ReturnType<typeof legacyQueueSnapshot>> | undefined;
  for (const row of rows) {
    try {
      const stop = async (status: 'FAILED' | 'CANCELLED' | 'TIMEOUT', reason: string, message: string) => {
        if (await markReviewTerminal(row.id, row.repository.userId, status, message, { reason, error: message }, row)) changed++;
      };
      if (!row.repository.isActive) {
        await stop('CANCELLED', 'repository-disconnected', 'Review stopped because the repository was disconnected.');
        continue;
      }
      if (queueUnavailable) continue;
      let queued: Job | undefined;
      try {
        queued = await queueRead(analysisQueue.getJob(row.queueJobId ?? row.id));
        if (!queued && !row.queueJobId && row.queueVersion !== 1) {
          legacy ??= await legacyQueueSnapshot();
          const candidates = legacy.jobs.filter(job => job?.data?.jobId === row.id);
          if (candidates.length > 1) continue; // ambiguity is not proof of abandonment
          queued = candidates[0];
          if (!queued && !legacy.complete) continue;
        }
      } catch { queueUnavailable = true; console.warn('Review recovery queue reads unavailable; retrying later'); continue; }
      if (queued && (queued.data?.jobId !== row.id || queued.data?.repositoryId !== row.repositoryId || queued.data?.userId !== row.repository.userId)) {
        console.warn('Review recovery refused a mismatched queue identity'); continue;
      }
      let queueState: string;
      try { queueState = queued ? await queueRead(queued.getState()) : 'unknown'; }
      catch { queueUnavailable = true; console.warn('Review recovery queue reads unavailable; retrying later'); continue; }
      const stale = Date.now() - row.updatedAt.getTime() > ABANDONED_REVIEW_GRACE_MS;
      if (queueState === 'failed') {
        await stop('FAILED', 'queue-attempts-exhausted', 'Review stopped after the queue exhausted its attempts.');
      } else if (queueState === 'completed') {
        await stop('FAILED', 'queue-ended-without-completion', 'Review processing ended before completion was recorded.');
      } else if (queueState === 'unknown' && stale) {
        await stop('FAILED', 'review-abandoned', 'Review stopped because its queue job is no longer available.');
      } else if (queueState === 'active' && stale) {
        // BullMQ may have just started a retry while the DB still shows an old
        // phase. Its processedOn timestamp protects that startup window.
        if (!queued?.processedOn || Date.now() - queued.processedOn > ABANDONED_REVIEW_GRACE_MS) {
          await stop('TIMEOUT', 'worker-heartbeat-expired', 'Review stopped because its worker stopped reporting progress.');
        }
      } else if (queued?.id && !row.queueJobId) {
        await prisma.analysisJob.updateMany({ where: { id: row.id, status: row.status, updatedAt: row.updatedAt },
          data: { queueJobId: queued.id } });
      }
    } catch { console.warn('Review recovery could not settle a review; retrying later'); }
  }
  return { checked: rows.length, changed, nextCursor: rows.length === BATCH_SIZE ? rows.at(-1)!.id : undefined };
}

/** Fast path; the periodic sweep also covers failures missed during downtime. */
export async function settleFailedQueueJob(job?: Job) {
  if (!job || await queueRead(job.getState()) !== 'failed') return;
  const row = await prisma.analysisJob.findUnique({ where: { id: job.data.jobId }, include: { repository: { select: { userId: true } } } });
  if (!row || row.repositoryId !== job.data.repositoryId || row.repository.userId !== job.data.userId) return;
  await markReviewTerminal(row.id, row.repository.userId, 'FAILED', 'Review stopped after the queue exhausted its attempts.',
    { reason: 'queue-attempts-exhausted' }, row);
}

/** Disconnect is authoritative even when Redis is unavailable; sweep handles later batches. */
export async function cancelDisconnectedReviews(repositoryId: string) {
  const rows = await prisma.analysisJob.findMany({
    where: { repositoryId, repository: { isActive: false }, status: { in: [...IN_PROGRESS_REVIEW_STATUSES] } },
    include: { repository: { select: { userId: true } } }, take: BATCH_SIZE, orderBy: { id: 'asc' },
  });
  for (const row of rows) await markReviewTerminal(row.id, row.repository.userId, 'CANCELLED',
    'Review stopped because the repository was disconnected.', { reason: 'repository-disconnected' });
}

export function startReviewRecovery() {
  let running = false, cursor: string | undefined;
  const tick = async () => {
    if (running) return;
    running = true;
    try { cursor = (await recoverReviewsOnce(cursor)).nextCursor; }
    catch { console.warn('Review recovery unavailable; retrying on the next scheduled check'); }
    finally { running = false; }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, RECOVERY_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
