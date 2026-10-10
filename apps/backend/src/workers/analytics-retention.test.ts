import { beforeEach, describe, expect, it, vi } from 'vitest';
import prisma from '../config/prisma';
import { sweepAnalyticsOnce } from './analytics-retention';
vi.mock('../config/prisma', () => ({ default: { reviewAnalyticsFact: { findMany: vi.fn(), deleteMany: vi.fn() } } }));
const db = prisma as any;
beforeEach(() => vi.clearAllMocks());
describe('bounded analytics retention', () => {
  it('deletes only the identified expired numeric facts, not raw findings or jobs', async () => {
    db.reviewAnalyticsFact.findMany.mockResolvedValue([{ id: 'expired' }]); db.reviewAnalyticsFact.deleteMany.mockResolvedValue({ count: 1 });
    expect(await sweepAnalyticsOnce()).toBe(1);
    expect(db.reviewAnalyticsFact.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 500, where: { expiresAt: { lte: expect.any(Date) } } }));
    expect(db.reviewAnalyticsFact.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['expired'] } } });
  });
  it('does not delete anything when there is no expired batch', async () => {
    db.reviewAnalyticsFact.findMany.mockResolvedValue([]); expect(await sweepAnalyticsOnce()).toBe(0);
    expect(db.reviewAnalyticsFact.deleteMany).not.toHaveBeenCalled();
  });
});
