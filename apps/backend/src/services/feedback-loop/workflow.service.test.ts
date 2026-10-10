import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../config/prisma', () => {
  const db: any = { $queryRaw: vi.fn(), findingOccurrence: { findFirst: vi.fn() },
    findingWorkflow: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    findingWorkflowEvent: { create: vi.fn(), findMany: vi.fn() } };
  db.$transaction = vi.fn(async (fn: any) => fn(db)); return { default: db };
});
import prisma from '../../config/prisma';
import { updateWorkflow, workflowEvents } from './workflow.service';
const db = prisma as any;
const occurrence = { id: 'occ', repositoryId: 'repo', superseded: false, createdAt: new Date(), analysisJob: { status: 'COMPLETED', createdAt: new Date() } };
beforeEach(() => {
  vi.resetAllMocks(); db.$transaction.mockImplementation(async (fn: any) => fn(db));
  db.$queryRaw.mockResolvedValue([{ id: 'repo' }]); db.findingOccurrence.findFirst.mockResolvedValue(occurrence);
  db.findingWorkflow.findUnique.mockResolvedValue(null);
  db.findingWorkflow.create.mockImplementation(async ({ data }: any) => ({ id: 'workflow', ...data }));
});
describe('finding workflow', () => {
  it('creates a separate revision and audit event without touching feedback', async () => {
    expect(await updateWorkflow('owner', 'job', 'occ', 'DISMISSED', 0)).toMatchObject({ status: 'DISMISSED', revision: 1 });
    expect(db.findingOccurrence.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: 'occ', analysisJobId: 'job', repository: { userId: 'owner', isActive: true },
    } }));
    expect(db.findingWorkflowEvent.create).toHaveBeenCalledWith({ data: { workflowId: 'workflow', actorId: 'owner', fromStatus: 'OPEN', status: 'DISMISSED', revision: 1 } });
  });
  it('retries the same intent without another audit event', async () => {
    db.findingWorkflow.findUnique.mockResolvedValue({ id: 'workflow', status: 'DISMISSED', revision: 1 });
    await updateWorkflow('owner', 'job', 'occ', 'DISMISSED', 0);
    expect(db.findingWorkflowEvent.create).not.toHaveBeenCalled();
  });
  it('rejects a stale different intent and uses a CAS update', async () => {
    db.findingWorkflow.findUnique.mockResolvedValue({ id: 'workflow', status: 'DISMISSED', revision: 1 });
    await expect(updateWorkflow('owner', 'job', 'occ', 'OPEN', 0)).rejects.toMatchObject({ status: 409 });
    db.findingWorkflow.update.mockResolvedValue({ id: 'workflow', status: 'OPEN', revision: 2 });
    await updateWorkflow('owner', 'job', 'occ', 'OPEN', 1);
    expect(db.findingWorkflow.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'workflow', revision: 1 } }));
  });
  it.each([undefined, -1, 0.5, '0', NaN])('rejects invalid revisions: %s', async revision => {
    await expect(updateWorkflow('owner', 'job', 'occ', 'OPEN', revision)).rejects.toMatchObject({ status: 400 });
  });
  it('rejects cross-tenant, superseded, expired, and changed-under-lock records', async () => {
    db.findingOccurrence.findFirst.mockResolvedValueOnce(null);
    await expect(updateWorkflow('intruder', 'job', 'occ', 'DISMISSED', 0)).rejects.toMatchObject({ status: 404 });
    db.findingOccurrence.findFirst.mockResolvedValue({ ...occurrence, superseded: true });
    await expect(updateWorkflow('owner', 'job', 'occ', 'DISMISSED', 0)).rejects.toMatchObject({ status: 409 });
    db.findingOccurrence.findFirst.mockResolvedValue({ ...occurrence, createdAt: new Date(0) });
    await expect(updateWorkflow('owner', 'job', 'occ', 'DISMISSED', 0)).rejects.toMatchObject({ status: 409 });
    db.findingOccurrence.findFirst.mockResolvedValueOnce(occurrence).mockResolvedValueOnce(null);
    await expect(updateWorkflow('owner', 'job', 'occ', 'DISMISSED', 0)).rejects.toMatchObject({ status: 404 });
  });
  it('bounds tenant-checked audit reads', async () => {
    db.findingWorkflowEvent.findMany.mockResolvedValue([]); await workflowEvents('owner', 'job', 'occ');
    expect(db.findingWorkflowEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100, where: { workflow: { occurrenceId: 'occ' } } }));
  });
});
