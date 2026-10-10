import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import prisma from '../../config/prisma';
import { normalizeStoredSuggestions, type AiSuggestion } from '../ai/finding-taxonomy';
import { generateFingerprint, buildFindingSummary } from './fingerprint.service';
import { dirtyHistory, historyCutoff, lockHistoricalRepository } from './state';
import { publishReviewAnalytics } from '../analytics/facts';

/** Exact artifact identity, not a fuzzy cross-review pattern or array position. */
export function findingIdentity(f: AiSuggestion): string {
  return createHash('sha256').update(JSON.stringify([
    f.filePath, f.lineNumber, f.agentType, f.priority, f.issue, f.suggestion,
    f.source ?? 'LLM', [...(f.sources ?? [f.source ?? 'LLM'])].sort(),
    [...(f.ruleKeys ?? [])].sort(), f.corroborated === true,
  ])).digest('hex');
}

function normalizedResults(results: unknown): AiSuggestion[] {
  return normalizeStoredSuggestions(Array.isArray(results) ? results :
    results && typeof results === 'object' ? (results as { suggestions?: unknown }).suggestions : []);
}

export const snapshotIdentity = (findings: AiSuggestion[]) => createHash('sha256')
  .update(JSON.stringify([...new Set(findings.map(findingIdentity))].sort())).digest('hex');

/** Completion and occurrence publication share one transaction. Legacy backfill
 * checks the stored artifact under lock and cannot resurrect expired reviews. */
export async function recordJobFindings(
  jobId: string, repositoryId: string, findings: AiSuggestion[],
  completedResults?: Prisma.InputJsonValue,
): Promise<void> {
  await prisma.$transaction(async tx => {
    await lockHistoricalRepository(tx, repositoryId);
    const repo = await tx.repository.findUnique({ where: { id: repositoryId } });
    const job = await tx.analysisJob.findFirst({ where: { id: jobId, repositoryId } });
    if (!job || !repo?.isActive) throw new Error('Review or repository unavailable');
    const normalized = normalizeStoredSuggestions(findings);
    const hash = snapshotIdentity(normalized);
    if (completedResults === undefined &&
      (job.status !== 'COMPLETED' || snapshotIdentity(normalizedResults(job.results)) !== hash)) {
      throw new Error('Review changed; reload before backfilling');
    }
    if (job.createdAt < historyCutoff()) throw new Error('Historical feedback retention has expired for this review');
    if (completedResults !== undefined) {
      await tx.analysisJob.update({ where: { id: jobId }, data: { status: 'COMPLETED', results: completedResults } });
    }
    if (job.findingSnapshotHash === hash) {
      if (completedResults !== undefined) await publishReviewAnalytics(tx, job, completedResults, job.findingSnapshot);
      return;
    }
    const revision = job.findingSnapshot + 1;
    await tx.findingOccurrence.updateMany({ where: { analysisJobId: jobId, superseded: false }, data: { superseded: true } });
    const unique = new Map(normalized.map(f => [findingIdentity(f), f]));
    if (unique.size) await tx.findingOccurrence.createMany({
      data: [...unique].map(([findingKey, f]) => ({
        repositoryId, analysisJobId: jobId, findingKey,
        snapshotKey: `${jobId}:${revision}:${findingKey}`, filePath: f.filePath,
        lineNumber: f.lineNumber, category: f.agentType, severity: f.priority,
        source: f.source ?? 'LLM', sources: f.sources ?? [f.source ?? 'LLM'],
        ruleKeys: f.ruleKeys ?? [], summary: buildFindingSummary(f), fingerprint: generateFingerprint(f),
      })),
    });
    await tx.analysisJob.update({ where: { id: jobId }, data: { findingSnapshot: revision, findingSnapshotHash: hash } });
    await dirtyHistory(tx, repositoryId);
    if (completedResults !== undefined) await publishReviewAnalytics(tx, job, completedResults, revision);
  }, { timeout: 15000 });
}

export async function getOccurrencesForJob(jobId: string) {
  return prisma.findingOccurrence.findMany({
    where: { analysisJobId: jobId, superseded: false, analysisJob: { createdAt: { gte: historyCutoff() } } },
    include: { feedback: true, workflow: true }, orderBy: { snapshotKey: 'asc' },
  });
}
