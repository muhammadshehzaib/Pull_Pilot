import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ update: vi.fn(), find: vi.fn(), remove: vi.fn() }));
vi.mock('../config/prisma', () => ({ default: { behavioralRun: { updateMany: m.update, findMany: m.find, deleteMany: m.remove } } }));
import { sweepBehavioralOnce } from './behavioral-retention';
beforeEach(() => vi.resetAllMocks());
it('persists runner timeouts and deletes only expired bounded run records', async () => {
  const now = new Date(); m.update.mockResolvedValue({ count: 1 }); m.find.mockResolvedValue([{ id: 'old' }]); m.remove.mockResolvedValue({ count: 1 });
  expect(await sweepBehavioralOnce(now)).toEqual({ timedOut: 1, deleted: 1 });
  expect(m.update).toHaveBeenCalledWith({ where: { status: { in: ['QUEUED', 'RUNNING'] }, deadlineAt: { lte: now } }, data: { status: 'TIMED_OUT', reason: 'CI_DEADLINE_EXCEEDED' } });
  expect(m.remove).toHaveBeenCalledWith({ where: { id: { in: ['old'] }, expiresAt: { lte: now } } });
});
