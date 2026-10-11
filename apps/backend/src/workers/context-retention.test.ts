import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAnalysisJob, mockCachedFile, mockPrisma } = vi.hoisted(() => {
  const mockAnalysisJob = {
    findMany: vi.fn(),
    deleteMany: vi.fn(),
  };
  const mockCachedFile = {
    findMany: vi.fn(),
    deleteMany: vi.fn(),
  };
  return {
    mockAnalysisJob,
    mockCachedFile,
    mockPrisma: { analysisJob: mockAnalysisJob, cachedFile: mockCachedFile,
      cachedImport: { findMany: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn() } },
  };
});

vi.mock('../config/prisma', () => ({ default: mockPrisma }));

import { sweepExpiredContextOnce } from './context-retention';

describe('sweepExpiredContextOnce', () => {
  beforeEach(() => {
    // resetAllMocks, not clearAllMocks: queued mockResolvedValueOnce values
    // survive a clear and would leak into the next test.
    vi.resetAllMocks();
    mockPrisma.cachedImport.findMany.mockResolvedValue([]);
  });

  it('does nothing when nothing has expired', async () => {
    mockCachedFile.findMany.mockResolvedValueOnce([]);

    await expect(sweepExpiredContextOnce()).resolves.toBe(0);
    expect(mockCachedFile.deleteMany).not.toHaveBeenCalled();
  });
  it('sweeps derived imports under the same expiry policy as source blobs', async () => {
    mockCachedFile.findMany.mockResolvedValueOnce([]);
    mockPrisma.cachedImport.findMany.mockResolvedValueOnce([{ id: 'expired-import' }]);
    mockPrisma.cachedImport.deleteMany.mockResolvedValueOnce({ count: 1 });
    expect(await sweepExpiredContextOnce()).toBe(1);
    expect(mockPrisma.cachedImport.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['expired-import'] } } });
  });

  it('deletes only rows at or past their expiry', async () => {
    mockCachedFile.findMany.mockResolvedValueOnce([]);

    await sweepExpiredContextOnce();

    const where = mockCachedFile.findMany.mock.calls[0][0].where;
    expect(where.expiresAt.lte).toBeInstanceOf(Date);
  });

  it('deletes in batches rather than building one enormous delete', async () => {
    const batch = Array.from({ length: 500 }, (_, i) => ({ id: `f${i}` }));
    mockCachedFile.findMany
      .mockResolvedValueOnce(batch)
      .mockResolvedValueOnce([{ id: 'last' }])
      .mockResolvedValueOnce([]);
    mockCachedFile.deleteMany
      .mockResolvedValueOnce({ count: 500 })
      .mockResolvedValueOnce({ count: 1 });

    await expect(sweepExpiredContextOnce()).resolves.toBe(501);
    expect(mockCachedFile.deleteMany).toHaveBeenCalledTimes(2);
    expect(mockCachedFile.deleteMany.mock.calls[0][0].where.id.in).toHaveLength(500);
  });

  it('stops when a partial batch indicates the backlog is drained', async () => {
    mockCachedFile.findMany.mockResolvedValueOnce([{ id: 'only' }]);
    mockCachedFile.deleteMany.mockResolvedValueOnce({ count: 1 });

    await expect(sweepExpiredContextOnce()).resolves.toBe(1);
    expect(mockCachedFile.findMany).toHaveBeenCalledTimes(1);
  });

  it('leaves job retention alone', async () => {
    mockCachedFile.findMany.mockResolvedValueOnce([]);

    await sweepExpiredContextOnce();

    expect(mockAnalysisJob.deleteMany).not.toHaveBeenCalled();
  });
});
