import { beforeEach, describe, expect, it, vi } from 'vitest';
import prisma from '../../config/prisma';
import { publishReviewAnalytics } from './facts';
import { backfillAnalyticsBatch } from './backfill';
vi.mock('../../config/prisma', () => {
  const db: any = { analysisJob: { findMany: vi.fn(), findFirst: vi.fn() }, $queryRaw: vi.fn() };
  db.$transaction = vi.fn(async (fn: any) => fn(db)); return { default: db };
});
vi.mock('./facts', () => ({ ANALYTICS_RETENTION_DAYS: 180, publishReviewAnalytics: vi.fn() }));
const db = prisma as any;
beforeEach(() => { vi.clearAllMocks(); db.analysisJob.findMany.mockResolvedValue([{ id: 'job', repositoryId: 'repo' }]);
  db.$queryRaw.mockResolvedValue([{ id: 'repo' }]); db.analysisJob.findFirst.mockResolvedValue({ id: 'job', results: [], findingSnapshot: 0 }); });
describe('explicit resumable legacy analytics backfill', () => {
  it('is dry-run first and only returns a bounded cursor, never source or findings', async () => {
    expect(await backfillAnalyticsBatch({ batchSize: 1 })).toEqual({ dryRun: true, candidates: 1, written: 0,
      nextCursor: 'job', timestampQuality: 'APPROXIMATE_CREATED_AT' });
    expect(publishReviewAnalytics).not.toHaveBeenCalled(); expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('requires apply, locks and rechecks each record; never changes its completion date', async () => {
    const result = await backfillAnalyticsBatch({ apply: true, after: 'cursor', batchSize: 1 }); expect(result.written).toBe(1);
    expect(db.analysisJob.findMany.mock.calls[0][0].where.id).toEqual({ gt: 'cursor' });
    expect(publishReviewAnalytics).toHaveBeenCalledWith(db, expect.anything(), [], 0, 'APPROXIMATE_CREATED_AT');
    expect(db.analysisJob.findFirst.mock.calls[0][0].where).toMatchObject({ status: 'COMPLETED', analyticsRevision: 0, repository: { isActive: true } });
  });
  it('does not overwrite records completed or disconnected concurrently', async () => {
    db.analysisJob.findFirst.mockResolvedValue(null);
    expect((await backfillAnalyticsBatch({ apply: true })).written).toBe(0); expect(publishReviewAnalytics).not.toHaveBeenCalled();
  });
  it.each([{ batchSize: 0 }, { batchSize: 101 }, { batchSize: 1.5 }, { after: '../unsafe' }])('rejects invalid options %j', async options => {
    await expect(backfillAnalyticsBatch(options)).rejects.toThrow(); expect(db.analysisJob.findMany).not.toHaveBeenCalled();
  });
});
