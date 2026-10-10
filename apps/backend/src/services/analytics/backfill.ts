import prisma from '../../config/prisma';
import { lockHistoricalRepository } from '../historical/state';
import { ANALYTICS_RETENTION_DAYS, publishReviewAnalytics } from './facts';

/** Explicit operator action; never runs at startup or invents a completion date. */
export async function backfillAnalyticsBatch(options: { apply?: boolean; after?: string; batchSize?: number } = {}) {
  const batchSize = options.batchSize ?? 100;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error('batchSize must be 1..100');
  if (options.after && !/^[a-zA-Z0-9-]{1,64}$/.test(options.after)) throw new Error('Invalid cursor');
  const rows = await prisma.analysisJob.findMany({ where: { status: 'COMPLETED', analyticsRevision: 0,
    repository: { isActive: true }, createdAt: { gte: new Date(Date.now() - ANALYTICS_RETENTION_DAYS * 86400000) },
    ...(options.after ? { id: { gt: options.after } } : {}) }, orderBy: { id: 'asc' }, take: batchSize,
    select: { id: true, repositoryId: true } });
  let written = 0;
  if (options.apply) for (const row of rows) await prisma.$transaction(async tx => {
    await lockHistoricalRepository(tx, row.repositoryId);
    const job = await tx.analysisJob.findFirst({ where: { id: row.id, status: 'COMPLETED', analyticsRevision: 0,
      repository: { isActive: true } } });
    if (!job) return;
    await publishReviewAnalytics(tx, job, job.results, job.findingSnapshot, 'APPROXIMATE_CREATED_AT');
    written++;
  });
  return { dryRun: !options.apply, candidates: rows.length, written,
    nextCursor: rows.length === batchSize ? rows.at(-1)!.id : null, timestampQuality: 'APPROXIMATE_CREATED_AT' };
}
