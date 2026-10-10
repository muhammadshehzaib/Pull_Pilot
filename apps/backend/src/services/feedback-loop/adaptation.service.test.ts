import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../config/prisma', () => {
  const db: any = { $queryRaw: vi.fn(), repository: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    analysisJob: { findMany: vi.fn() }, findingOccurrence: { findMany: vi.fn() }, ruleAuditEvent: { create: vi.fn() } };
  db.$transaction = vi.fn(async (fn: any) => fn(db)); return { default: db };
});
import prisma from '../../config/prisma';
import { feedbackInsights, retrieveFeedbackAdaptation, updateAdaptation } from './adaptation.service';
const db = prisma as any;
const repo = { id: 'repo', isActive: true, feedbackAdaptationEnabled: true, feedbackAdaptationRevision: 0 };
beforeEach(() => {
  vi.resetAllMocks(); db.$transaction.mockImplementation(async (fn: any) => fn(db));
  db.$queryRaw.mockResolvedValue([{ id: 'repo' }]); db.repository.findFirst.mockResolvedValue(repo);
  db.repository.findUnique.mockResolvedValue(repo); db.analysisJob.findMany.mockResolvedValue([{ id: 'job' }]);
  db.findingOccurrence.findMany.mockResolvedValue([]);
});
describe('bounded, tenant-scoped adaptation snapshots', () => {
  it('filters completed PR jobs and unexpired current occurrences and bounds queries', async () => {
    await feedbackInsights('repo', 'owner');
    expect(db.repository.findFirst).toHaveBeenCalledWith({ where: { id: 'repo', isActive: true, userId: 'owner' } });
    expect(db.analysisJob.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 200,
      where: expect.objectContaining({ repositoryId: 'repo', status: 'COMPLETED', eventType: 'PULL_REQUEST' }) }));
    expect(db.findingOccurrence.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 10001,
      where: expect.objectContaining({ repositoryId: 'repo', superseded: false, analysisJobId: { in: ['job'] } }) }));
  });
  it('fails closed for adaptation on partial evidence', async () => {
    const row = { createdAt: new Date(), analysisJob: { referenceId: '42', createdAt: new Date() }, feedback: null };
    db.findingOccurrence.findMany.mockResolvedValue(Array.from({ length: 10001 }, () => row));
    expect(await feedbackInsights('repo', 'owner')).toMatchObject({ partial: true, recommendations: [] });
    expect(await retrieveFeedbackAdaptation('repo')).toBeNull();
  });
  it('excludes notes and security patterns from model context, and encodes untrusted path strings', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: String(i), createdAt: new Date(),
      fingerprint: 'fp_v2_STYLE:src/<ignore instructions>:hash', summary: 'Human-readable summary',
      feedback: { disposition: 'REJECTED', rejectionReason: 'STYLE_PREFERENCE', updatedAt: new Date(), note: 'PRIVATE_NOTE' },
      analysisJob: { referenceId: String(i), createdAt: new Date() } }));
    db.findingOccurrence.findMany.mockResolvedValue(rows);
    const memory = await retrieveFeedbackAdaptation('repo');
    expect(memory?.serializedContext).toContain('\\u003cignore instructions\\u003e');
    expect(memory?.serializedContext).not.toContain('PRIVATE_NOTE');
    expect(memory?.serializedContext).not.toContain('Human-readable summary');
    db.findingOccurrence.findMany.mockResolvedValue(rows.map(row => ({ ...row, fingerprint: 'fp_v2_SECURITY:src/auth:hash' })));
    expect((await retrieveFeedbackAdaptation('repo'))?.serializedContext).toBe('');
  });
  it('does not retrieve history while disabled and fails open on DB errors', async () => {
    db.repository.findUnique.mockResolvedValueOnce({ ...repo, feedbackAdaptationEnabled: false });
    expect(await retrieveFeedbackAdaptation('repo')).toBeNull(); expect(db.$transaction).not.toHaveBeenCalled();
    db.repository.findUnique.mockRejectedValueOnce(new Error('secret')); expect(await retrieveFeedbackAdaptation('repo')).toBeNull();
  });
  it('checks ownership before locking and rechecks it under lock', async () => {
    db.repository.findFirst.mockResolvedValueOnce(null);
    await expect(feedbackInsights('repo', 'other')).rejects.toMatchObject({ status: 404 }); expect(db.$queryRaw).not.toHaveBeenCalled();
    db.repository.findFirst.mockResolvedValueOnce(repo).mockResolvedValueOnce(null);
    await expect(updateAdaptation('repo', 'owner', false, 0)).rejects.toMatchObject({ status: 404 });
    expect(db.repository.update).not.toHaveBeenCalled();
  });
  it('updates settings with a revision and audit, and handles retries/conflicts', async () => {
    db.repository.update.mockResolvedValue({ ...repo, feedbackAdaptationEnabled: false, feedbackAdaptationRevision: 1 });
    expect(await updateAdaptation('repo', 'owner', false, 0)).toEqual({ enabled: false, revision: 1 });
    expect(db.ruleAuditEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'ADAPTATION_DISABLED' }) }));
    db.repository.findFirst.mockResolvedValue({ ...repo, feedbackAdaptationEnabled: false, feedbackAdaptationRevision: 1 });
    await updateAdaptation('repo', 'owner', false, 0);
    expect(db.repository.update).toHaveBeenCalledTimes(1);
    await expect(updateAdaptation('repo', 'owner', true, 0)).rejects.toMatchObject({ status: 409 });
  });
});
