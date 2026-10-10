import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AiSuggestion } from '../ai/finding-taxonomy';

// Opt-in only: apply migrations to a disposable database before invoking this suite.
const url = process.env.HISTORICAL_TEST_DATABASE_URL;
describe.skipIf(!url)('historical intelligence PostgreSQL integration', () => {
  let prisma: typeof import('../../config/prisma').default;
  let recordJobFindings: typeof import('./occurrence.service').recordJobFindings;
  let getOccurrencesForJob: typeof import('./occurrence.service').getOccurrencesForJob;
  let updateFeedback: typeof import('./feedback.service').updateFeedback;
  let aggregateRepositoryPatterns: typeof import('./aggregation.service').aggregateRepositoryPatterns;
  let retrieveHistoricalMemory: typeof import('./review-memory.service').retrieveHistoricalMemory;
  let sweepHistoricalOnce: typeof import('../../workers/historical-maintenance').sweepHistoricalOnce;
  let clearRepositoryHistory: typeof import('../../workers/historical-maintenance').clearRepositoryHistory;
  const ownerId = randomUUID();
  let repoId: string;
  const finding: AiSuggestion = { filePath: 'src/Auth.ts', lineNumber: 10, agentType: 'BUG', priority: 'HIGH',
    source: 'LLM', issue: 'Missing null guard', suggestion: 'Add null check' };
  async function review(pr: string, findings = [finding]) {
    const job = await prisma.analysisJob.create({ data: { repositoryId: repoId, eventType: 'PULL_REQUEST', referenceId: pr, commitSha: randomUUID(), status: 'POSTING' } });
    await recordJobFindings(job.id, repoId, findings, { suggestions: findings });
    return job;
  }
  beforeAll(async () => {
    const target = new URL(url!);
    if (!['localhost', '127.0.0.1'].includes(target.hostname) || !target.pathname.endsWith('_test') || process.env.DATABASE_URL !== url) {
      throw new Error('Integration tests require an explicitly selected local disposable *_test database');
    }
    // Do not instantiate Prisma (or load .env) when the integration suite is skipped.
    prisma = (await import('../../config/prisma')).default;
    ({ recordJobFindings, getOccurrencesForJob } = await import('./occurrence.service'));
    ({ updateFeedback } = await import('./feedback.service'));
    ({ aggregateRepositoryPatterns } = await import('./aggregation.service'));
    ({ retrieveHistoricalMemory } = await import('./review-memory.service'));
    ({ sweepHistoricalOnce, clearRepositoryHistory } = await import('../../workers/historical-maintenance'));
    await prisma.user.create({ data: { id: ownerId, githubId: ownerId, username: 'phase8-test' } });
    const repo = await prisma.repository.create({ data: { userId: ownerId, githubRepoId: BigInt(Date.now()), fullName: 'phase8/disposable', historicalIntelligenceEnabled: true } });
    repoId = repo.id;
  });
  afterAll(async () => {
    if (repoId) await prisma.user.delete({ where: { id: ownerId } });
    if (prisma) await prisma.$disconnect();
  });
  it('commits the result and occurrence IDs atomically; retry and empty regeneration are safe', async () => {
    const job = await review('1');
    const initial = await getOccurrencesForJob(job.id);
    await recordJobFindings(job.id, repoId, [finding], { suggestions: [finding] });
    expect((await getOccurrencesForJob(job.id))[0].id).toBe(initial[0].id);
    await recordJobFindings(job.id, repoId, [], { suggestions: [] });
    expect(await getOccurrencesForJob(job.id)).toEqual([]);
    expect((await prisma.findingOccurrence.findUnique({ where: { id: initial[0].id } }))?.superseded).toBe(true);
    expect((await prisma.analysisJob.findUnique({ where: { id: job.id } }))?.results).toEqual({ suggestions: [] });
    const current = await prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } });
    await expect(recordJobFindings(job.id, repoId, [finding], { suggestions: [finding] })).resolves.toBeUndefined();
    expect((await getOccurrencesForJob(job.id))[0].id).not.toBe(initial[0].id);
    expect((await prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } })).findingSnapshot).toBe(current.findingSnapshot + 1);
  });
  it('serializes concurrent initial feedback, existing edits, duplicate retries and audit revisions', async () => {
    const job = await review('2'); const [occ] = await getOccurrencesForJob(job.id);
    const input = { occurrenceId: occ.id, actorId: ownerId, disposition: 'ACCEPTED' as const, expectedRevision: 0 };
    const initial = await Promise.allSettled([updateFeedback(input), updateFeedback({ ...input, disposition: 'NEEDS_REVIEW' })]);
    expect(initial.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const edits = await Promise.allSettled([
      updateFeedback({ ...input, expectedRevision: 1, disposition: 'REJECTED', rejectionReason: 'FALSE_POSITIVE' }),
      updateFeedback({ ...input, expectedRevision: 1, disposition: 'UNREVIEWED' }),
    ]);
    expect(edits.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const feedback = await prisma.findingFeedback.findUniqueOrThrow({ where: { occurrenceId: occ.id }, include: { events: true } });
    expect(feedback.revision).toBe(2);
    expect(feedback.events.map(event => event.revision).sort()).toEqual([1, 2]);
    await updateFeedback({ ...input, disposition: feedback.disposition,
      rejectionReason: feedback.rejectionReason ?? undefined, expectedRevision: 1 });
    expect(await prisma.findingFeedbackEvent.count({ where: { feedbackId: feedback.id } })).toBe(2);
    await expect(updateFeedback({ ...input, actorId: randomUUID(), expectedRevision: 2 })).rejects.toThrow();
  });
  it('rolls back result publication and supersession if inserting the new artifact fails', async () => {
    const job = await review('rollback');
    const before = await prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } });
    const [occ] = await getOccurrencesForJob(job.id);
    const invalid = { ...finding, lineNumber: 3_000_000_000 };
    await expect(recordJobFindings(job.id, repoId, [invalid], { suggestions: [invalid] })).rejects.toThrow();
    const after = await prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.results).toEqual(before.results);
    expect(after.findingSnapshot).toBe(before.findingSnapshot);
    expect((await getOccurrencesForJob(job.id))[0].id).toBe(occ.id);
    // Avoid changing the independent PR support expected by the next test.
    await prisma.analysisJob.delete({ where: { id: job.id } });
  });
  it('enforces PR support and case-sensitive grouping, and refreshes after feedback', async () => {
    await review('3'); await review('4');
    await review('5', [{ ...finding, filePath: 'src/auth.ts' }]);
    await aggregateRepositoryPatterns(repoId);
    const memory = await retrieveHistoricalMemory(repoId, ['src/Auth.ts']);
    expect(memory?.patterns).toHaveLength(1);
    expect(memory?.patterns[0].distinctPrCount).toBe(4);
    const occurrence = await prisma.findingOccurrence.findFirstOrThrow({ where: { repositoryId: repoId, filePath: 'src/Auth.ts', superseded: false, feedback: null } });
    await updateFeedback({ occurrenceId: occurrence.id, actorId: ownerId, disposition: 'REJECTED', rejectionReason: 'FALSE_POSITIVE', expectedRevision: 0 });
    expect(await prisma.historicalPattern.count({ where: { repositoryId: repoId } })).toBe(0);
    expect((await retrieveHistoricalMemory(repoId, ['src/Auth.ts']))?.patterns[0].rejectedCount).toBeGreaterThanOrEqual(1);
    await prisma.repository.update({ where: { id: repoId }, data: { historicalIntelligenceEnabled: false } });
    expect(await retrieveHistoricalMemory(repoId)).toBeNull();
    await prisma.repository.update({ where: { id: repoId }, data: { historicalIntelligenceEnabled: true } });
  });
  it('deleting a job invalidates aggregates through the database trigger', async () => {
    const job = await review('6'); await aggregateRepositoryPatterns(repoId);
    expect(await prisma.historicalPattern.count({ where: { repositoryId: repoId } })).toBeGreaterThan(0);
    await prisma.analysisJob.delete({ where: { id: job.id } });
    expect(await prisma.historicalPattern.count({ where: { repositoryId: repoId } })).toBe(0);
  });
  it('expires raw feedback and its audit events and blocks backfill resurrection', async () => {
    const job = await review('7'); const [occ] = await getOccurrencesForJob(job.id);
    await updateFeedback({ occurrenceId: occ.id, actorId: ownerId, disposition: 'ACCEPTED', expectedRevision: 0 });
    const feedback = await prisma.findingFeedback.findUniqueOrThrow({ where: { occurrenceId: occ.id } });
    await prisma.analysisJob.update({ where: { id: job.id }, data: { createdAt: new Date(0) } });
    await expect(recordJobFindings(job.id, repoId, [finding])).rejects.toThrow('expired');
    await sweepHistoricalOnce();
    expect(await prisma.findingOccurrence.findUnique({ where: { id: occ.id } })).toBeNull();
    expect(await prisma.findingFeedback.count({ where: { occurrenceId: occ.id } })).toBe(0);
    expect(await prisma.findingFeedbackEvent.count({ where: { feedbackId: feedback.id } })).toBe(0);
  });
  it('rebuilds legacy case-flattened fingerprints using their original paths', async () => {
    for (const filePath of ['src/Legacy.ts', 'src/legacy.ts']) {
      for (let i = 0; i < 3; i++) {
        const job = await review(`legacy-${filePath}-${i}`, [{ ...finding, filePath }]);
        await prisma.findingOccurrence.updateMany({ where: { analysisJobId: job.id },
          data: { fingerprint: 'fp_v1_BUG:src/legacy:deadbeefdeadbeef' } });
      }
    }
    await aggregateRepositoryPatterns(repoId);
    const patterns = await prisma.historicalPattern.findMany({ where: { repositoryId: repoId, fingerprint: { endsWith: 'deadbeefdeadbeef' } } });
    expect(patterns).toHaveLength(2);
    expect(patterns.map(p => p.distinctPrCount)).toEqual([3, 3]);
  });
  it('disconnect clears raw feedback and derived memory and disables influence', async () => {
    await clearRepositoryHistory(repoId);
    expect(await prisma.findingOccurrence.count({ where: { repositoryId: repoId } })).toBe(0);
    expect(await prisma.historicalPattern.count({ where: { repositoryId: repoId } })).toBe(0);
    expect((await prisma.repository.findUniqueOrThrow({ where: { id: repoId } })).historicalIntelligenceEnabled).toBe(false);
  });
});
