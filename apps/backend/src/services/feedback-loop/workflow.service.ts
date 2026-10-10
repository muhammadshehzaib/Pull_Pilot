import type { Prisma, FindingWorkflowStatus } from '@prisma/client';
import prisma from '../../config/prisma';
import { historyCutoff, lockHistoricalRepository } from '../historical/state';

export class LoopError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function requireRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new LoopError(400, 'expectedRevision must be a non-negative integer');
  }
  return value;
}

/** Lock order matches Phase 8. Recheck the entire relation after the lock. */
export async function eligibleFinding(tx: Prisma.TransactionClient, actorId: string, jobId: string, occurrenceId: string) {
  const where = { id: occurrenceId, analysisJobId: jobId, repository: { userId: actorId, isActive: true } };
  let occurrence = await tx.findingOccurrence.findFirst({ where, include: { analysisJob: true } });
  if (!occurrence) throw new LoopError(404, 'Finding unavailable');
  await lockHistoricalRepository(tx, occurrence.repositoryId);
  occurrence = await tx.findingOccurrence.findFirst({ where, include: { analysisJob: true } });
  if (!occurrence) throw new LoopError(404, 'Finding unavailable');
  if (occurrence.superseded || occurrence.analysisJob.status !== 'COMPLETED' ||
      occurrence.createdAt < historyCutoff() || occurrence.analysisJob.createdAt < historyCutoff()) {
    throw new LoopError(409, 'Finding changed or expired; reload the review');
  }
  return occurrence;
}

export async function updateWorkflow(actorId: string, jobId: string, occurrenceId: string, status: unknown, expected: unknown) {
  const revision = requireRevision(expected);
  if (!['OPEN', 'DISMISSED', 'REPORTED_FIXED'].includes(status as string)) throw new LoopError(400, 'Invalid workflow status');
  return prisma.$transaction(async tx => {
    await eligibleFinding(tx, actorId, jobId, occurrenceId);
    const current = await tx.findingWorkflow.findUnique({ where: { occurrenceId } });
    if (current && current.status === status && [current.revision, current.revision - 1].includes(revision)) return current;
    if ((current?.revision ?? 0) !== revision) throw new LoopError(409, 'Workflow changed; reload before retrying');
    if (!current && status === 'OPEN') return { status: 'OPEN', revision: 0 };
    const workflow = current
      ? await tx.findingWorkflow.update({ where: { id: current.id, revision }, data: {
        status: status as FindingWorkflowStatus, actorId, revision: { increment: 1 },
      } })
      : await tx.findingWorkflow.create({ data: { occurrenceId, status: status as FindingWorkflowStatus, actorId, revision: 1 } });
    await tx.findingWorkflowEvent.create({ data: { workflowId: workflow.id, actorId,
      fromStatus: current?.status ?? 'OPEN', status: workflow.status, revision: workflow.revision } });
    return workflow;
  });
}

export async function workflowEvents(actorId: string, jobId: string, occurrenceId: string) {
  return prisma.$transaction(async tx => {
    await eligibleFinding(tx, actorId, jobId, occurrenceId);
    return tx.findingWorkflowEvent.findMany({ where: { workflow: { occurrenceId } },
      orderBy: [{ createdAt: 'desc' }, { revision: 'desc' }], take: 100 });
  });
}
