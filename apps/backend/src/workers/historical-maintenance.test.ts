import { beforeEach, describe, expect, it, vi } from 'vitest';
import prisma from '../config/prisma';
import { aggregateRepositoryPatterns } from '../services/historical/aggregation.service';
import { sweepHistoricalOnce, clearRepositoryHistory } from './historical-maintenance';
vi.mock('../services/historical/aggregation.service', () => ({ aggregateRepositoryPatterns: vi.fn() }));
vi.mock('../config/prisma', () => {
  const db: any = { $queryRaw: vi.fn(),
    findingOccurrence: { findMany: vi.fn(), deleteMany: vi.fn() },
    repository: { update: vi.fn() }, historicalPattern: { deleteMany: vi.fn() },
    ruleAuditEvent: { findMany: vi.fn(), deleteMany: vi.fn() },
  };
  db.$transaction = vi.fn(async (fn: any) => fn(db)); return { default: db };
});
const db = prisma as any;
beforeEach(() => {
  vi.clearAllMocks();
  db.findingOccurrence.findMany.mockResolvedValue([]);
  db.ruleAuditEvent.findMany.mockResolvedValue([]);
  db.$queryRaw.mockResolvedValue([]);
});
describe('bounded historical maintenance', () => {
  it('deletes only a bounded batch and invalidates the owning repository', async () => {
    db.findingOccurrence.findMany.mockResolvedValueOnce([{ id: 'expired', repositoryId: 'repo' }]);
    db.$queryRaw.mockResolvedValueOnce([{ id: 'repo' }]).mockResolvedValueOnce([]);
    expect(await sweepHistoricalOnce()).toBe(1);
    expect(db.findingOccurrence.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 500 }));
    expect(db.findingOccurrence.deleteMany).toHaveBeenCalledWith({ where: { repositoryId: 'repo', id: { in: ['expired'] } } });
    expect(db.repository.update).toHaveBeenCalledWith(expect.objectContaining({ data: { historicalRevision: { increment: 1 } } }));
  });
  it('retries durable pending work on the next pass after a rebuild failure', async () => {
    db.$queryRaw.mockResolvedValue([{ id: 'repo' }]);
    vi.mocked(aggregateRepositoryPatterns).mockRejectedValueOnce(new Error('DB unavailable'));
    await sweepHistoricalOnce(); await sweepHistoricalOnce();
    expect(aggregateRepositoryPatterns).toHaveBeenCalledTimes(2);
    expect(db.$queryRaw.mock.calls[0][0].join('')).toContain('LIMIT 10');
    expect(db.repository.update).not.toHaveBeenCalled();
  });
  it('disconnect erases raw history and disables historical influence', async () => {
    db.$queryRaw.mockResolvedValueOnce([{ id: 'repo' }]);
    await clearRepositoryHistory('repo');
    expect(db.findingOccurrence.deleteMany).toHaveBeenCalledWith({ where: { repositoryId: 'repo' } });
    expect(db.historicalPattern.deleteMany).toHaveBeenCalledWith({ where: { repositoryId: 'repo' } });
    expect(db.repository.update).toHaveBeenLastCalledWith({ where: { id: 'repo' }, data: { historicalIntelligenceEnabled: false,
      feedbackAdaptationEnabled: false, feedbackAdaptationRevision: { increment: 1 } } });
  });
});
