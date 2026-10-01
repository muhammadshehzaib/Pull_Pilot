import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockJobFindMany, mockJobDeleteMany } = vi.hoisted(() => ({
  mockJobFindMany: vi.fn(),
  mockJobDeleteMany: vi.fn(),
}));

vi.mock('../config/prisma', () => ({
  default: {
    analysisJob: { findMany: mockJobFindMany, deleteMany: mockJobDeleteMany },
  },
}));

import { sweepFailedJobsOnce } from './job-retention';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('sweepFailedJobsOnce', () => {
  beforeEach(() => {
    // resetAllMocks, not clearAllMocks: the latter leaves unconsumed
    // mockResolvedValueOnce values queued, which leak into the next test.
    vi.resetAllMocks();
    mockJobFindMany.mockResolvedValue([]);
    // report however many ids the code actually passed, like Prisma does
    mockJobDeleteMany.mockImplementation(
      ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve({ count: where.id.in.length }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('deletes nothing when there are no stale failed jobs', async () => {
    mockJobFindMany.mockResolvedValue([]);

    const removed = await sweepFailedJobsOnce(7);

    expect(removed).toBe(0);
    expect(mockJobDeleteMany).not.toHaveBeenCalled();
  });

  it('only sweeps FAILED rows older than the retention window', async () => {
    const removed = await sweepFailedJobsOnce(7);

    expect(removed).toBe(0);
    const where = mockJobFindMany.mock.calls[0][0].where;
    expect(where.status).toBe('FAILED');

    const cutoff = where.updatedAt.lt.getTime();
    const expected = Date.now() - 7 * DAY_MS;
    // allow for the few ms the test itself takes to run
    expect(Math.abs(cutoff - expected)).toBeLessThan(5000);
  });

  it('never touches COMPLETED, QUEUED or RUNNING rows', async () => {
    await sweepFailedJobsOnce(7);

    const where = mockJobFindMany.mock.calls[0][0].where;
    expect(where.status).not.toBe('COMPLETED');
    expect(where.status).not.toBe('QUEUED');
    expect(where.status).not.toBe('RUNNING');
  });

  it('deletes the ids it selected and returns the count', async () => {
    mockJobFindMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    mockJobDeleteMany.mockResolvedValue({ count: 3 });

    const removed = await sweepFailedJobsOnce(7);

    expect(removed).toBe(3);
    expect(mockJobDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['a', 'b', 'c'] } },
    });
  });

  it('loops until the backlog is drained, then stops', async () => {
    // a full batch, then a partial one which ends the loop without a third query
    const full = Array.from({ length: 500 }, (_, i) => ({ id: `job-${i}` }));
    mockJobFindMany
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce([{ id: 'last' }])
      .mockResolvedValueOnce([]);

    const removed = await sweepFailedJobsOnce(7);

    // 500 + 1 — the delete count follows the ids actually selected
    expect(removed).toBe(501);
    // the short second batch breaks the loop, so the queued third value is unused
    expect(mockJobFindMany).toHaveBeenCalledTimes(2);
  });

  it('stops looping on a short batch without a further query', async () => {
    mockJobFindMany.mockResolvedValue([{ id: 'only' }]);
    mockJobDeleteMany.mockResolvedValue({ count: 1 });
    const removed = await sweepFailedJobsOnce(7);

    expect(removed).toBe(1);
    expect(mockJobFindMany).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for a non-positive or invalid retention window', async () => {
    expect(await sweepFailedJobsOnce(0)).toBe(0);
    expect(await sweepFailedJobsOnce(-1)).toBe(0);
    expect(await sweepFailedJobsOnce(NaN)).toBe(0);

    expect(mockJobFindMany).not.toHaveBeenCalled();
    expect(mockJobDeleteMany).not.toHaveBeenCalled();
  });

  it('counts only rows actually deleted, not rows selected', async () => {
    mockJobFindMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    // a concurrent worker moved one row out of FAILED, so only one matches
    mockJobDeleteMany.mockResolvedValue({ count: 1 });

    const removed = await sweepFailedJobsOnce(7);

    expect(removed).toBe(1);
  });
});
