import { beforeEach, describe, expect, it, vi } from 'vitest';
import prisma from '../../config/prisma';
import { updateFeedback, FeedbackConflictError, getFeedbackEvents, getFeedbackForOccurrences } from './feedback.service';
vi.mock('../../config/prisma', () => {
  const db: any = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'repo' }]),
    findingOccurrence: { findFirst: vi.fn() }, repository: { update: vi.fn() },
    historicalPattern: { deleteMany: vi.fn() },
    findingFeedback: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    findingFeedbackEvent: { create: vi.fn() },
  };
  // Serialize like the per-repository PostgreSQL FOR UPDATE lock.
  let tail = Promise.resolve();
  db.$transaction = vi.fn((fn: any) => {
    const result = tail.then(() => fn(db));
    tail = result.catch(() => {});
    return result;
  });
  return { default: db };
});
const db = prisma as any;
let current: any;
const input = { occurrenceId: 'occ', actorId: 'owner', disposition: 'ACCEPTED' as const, expectedRevision: 0 };
beforeEach(() => {
  vi.clearAllMocks(); current = null;
  db.findingOccurrence.findFirst.mockResolvedValue({ repositoryId: 'repo' });
  db.findingFeedback.findUnique.mockImplementation(async () => current ? { ...current } : null);
  db.findingFeedback.create.mockImplementation(async ({ data }: any) => current = { ...data, id: 'fb', updatedAt: new Date() });
  db.findingFeedback.update.mockImplementation(async ({ where, data }: any) => {
    expect(where.revision).toBe(current.revision);
    return current = { ...current, ...data };
  });
});
describe('atomic feedback and durable invalidation', () => {
  it('does not query feedback for an empty batch', async () => {
    expect((await getFeedbackForOccurrences([])).size).toBe(0);
    expect(db.findingFeedback.findMany).not.toHaveBeenCalled();
  });
  it('retrieves feedback only for the supplied occurrences', async () => {
    db.findingFeedback.findMany.mockResolvedValueOnce([{ id: 'fb', occurrenceId: 'occ', disposition: 'ACCEPTED',
      rejectionReason: null, note: null, revision: 1, updatedAt: new Date() }]);
    expect((await getFeedbackForOccurrences(['occ'])).get('occ')?.revision).toBe(1);
    expect(db.findingFeedback.findMany).toHaveBeenCalledWith({ where: { occurrenceId: { in: ['occ'] } } });
  });
  it('creates revision 1 and invalidates aggregates in the same transaction', async () => {
    const result = await updateFeedback(input);
    expect(result.revision).toBe(1);
    expect(db.findingFeedbackEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ revision: 1 }) });
    expect(db.repository.update).toHaveBeenCalledWith({ where: { id: 'repo' }, data: { historicalRevision: { increment: 1 } } });
    expect(db.historicalPattern.deleteMany).toHaveBeenCalledWith({ where: { repositoryId: 'repo' } });
  });
  it('retries the same intent idempotently without a second audit event', async () => {
    await updateFeedback(input); await updateFeedback(input);
    expect(db.findingFeedbackEvent.create).toHaveBeenCalledTimes(1);
    expect(current.revision).toBe(1);
  });
  it('only one of two concurrent different initial submissions succeeds', async () => {
    const results = await Promise.allSettled([updateFeedback(input), updateFeedback({ ...input, disposition: 'NEEDS_REVIEW' })]);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(FeedbackConflictError);
    expect(db.findingFeedbackEvent.create).toHaveBeenCalledTimes(1);
  });
  it('rejects concurrent existing-row edits and keeps unique monotonic revisions', async () => {
    await updateFeedback(input);
    const results = await Promise.allSettled([
      updateFeedback({ ...input, expectedRevision: 1, disposition: 'NEEDS_REVIEW' }),
      updateFeedback({ ...input, expectedRevision: 1, disposition: 'REJECTED', rejectionReason: 'FALSE_POSITIVE' }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(db.findingFeedback.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'fb', revision: 1 } }));
    expect(current.revision).toBe(2);
  });
  it('supports reset and requires a revision even for creation', async () => {
    await expect(updateFeedback({ ...input, expectedRevision: undefined })).rejects.toThrow('required');
    await updateFeedback(input);
    expect((await updateFeedback({ ...input, expectedRevision: 1, disposition: 'UNREVIEWED' })).revision).toBe(2);
  });
  it('denies cross-tenant, superseded and expired occurrences before writing', async () => {
    db.findingOccurrence.findFirst.mockResolvedValue(null);
    await expect(updateFeedback(input)).rejects.toBeInstanceOf(FeedbackConflictError);
    expect(db.findingOccurrence.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      repository: { userId: 'owner', isActive: true }, superseded: false,
      analysisJob: expect.objectContaining({ status: 'COMPLETED' }),
    }) }));
    expect(db.findingFeedback.create).not.toHaveBeenCalled();
  });
  it('rechecks ownership and supersession after acquiring the repository lock', async () => {
    db.findingOccurrence.findFirst.mockResolvedValueOnce({ repositoryId: 'repo' }).mockResolvedValueOnce(null);
    await expect(updateFeedback(input)).rejects.toBeInstanceOf(FeedbackConflictError);
    expect(db.findingFeedback.create).not.toHaveBeenCalled();
  });
  it('validates rejection reasons and note size', async () => {
    await expect(updateFeedback({ ...input, disposition: 'REJECTED' })).rejects.toThrow('rejectionReason');
    await expect(updateFeedback({ ...input, note: 'x'.repeat(1001) })).rejects.toThrow('maximum');
  });
  it('bounds the audit history response', async () => {
    db.findingFeedback.findUnique.mockResolvedValueOnce({ events: [] });
    await getFeedbackEvents('occ');
    expect(db.findingFeedback.findUnique).toHaveBeenCalledWith(expect.objectContaining({ include: { events: { orderBy: { createdAt: 'desc' }, take: 100 } } }));
  });
});
