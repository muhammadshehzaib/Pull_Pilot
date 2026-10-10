import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DAY, parseScope } from './model';
import { METRICS_VERSION, RISK_ALGORITHM_VERSION } from './facts';

const url = process.env.ANALYTICS_TEST_DATABASE_URL;
describe.skipIf(!url)('engineering health PostgreSQL integration', () => {
  let prisma: typeof import('../../config/prisma').default;
  let publish: typeof import('../historical/occurrence.service').recordJobFindings;
  let health: typeof import('./dashboard.service').engineeringHealth;
  let backfill: typeof import('./backfill').backfillAnalyticsBatch;
  let workflow: typeof import('../feedback-loop/workflow.service').updateWorkflow;
  let clear: typeof import('../../workers/historical-maintenance').clearRepositoryHistory;
  const owner = randomUUID(), other = randomUUID(); let repo: string;
  const f = { filePath: 'src/a.ts', lineNumber: 1, agentType: 'SECURITY' as const, priority: 'CRITICAL' as const,
    source: 'SAST' as const, issue: 'Unsafe input', suggestion: 'Validate input' };
  const result = { suggestions: [f], riskV2: { version: 2, direction: 'HIGHER_IS_RISKIER', score: 30 },
    analyticsConfiguration: { riskAlgorithmVersion: RISK_ALGORITHM_VERSION, fixture: true } };
  const scope = async (query: Record<string, unknown> = {}) => { await new Promise(resolve => setTimeout(resolve, 3)); return parseScope(query); };
  async function job(referenceId: string, eventType: 'PULL_REQUEST' | 'PUSH' = 'PULL_REQUEST') {
    return prisma.analysisJob.create({ data: { repositoryId: repo, referenceId, eventType, commitSha: randomUUID(), status: 'POSTING' } });
  }
  beforeAll(async () => {
    const target = new URL(url!);
    if (!['127.0.0.1', 'localhost'].includes(target.hostname) || !target.pathname.endsWith('_test') || process.env.DATABASE_URL !== url)
      throw new Error('Requires an explicitly selected local disposable *_test database');
    prisma = (await import('../../config/prisma')).default;
    ({ recordJobFindings: publish } = await import('../historical/occurrence.service'));
    ({ engineeringHealth: health } = await import('./dashboard.service'));
    ({ backfillAnalyticsBatch: backfill } = await import('./backfill'));
    ({ updateWorkflow: workflow } = await import('../feedback-loop/workflow.service'));
    ({ clearRepositoryHistory: clear } = await import('../../workers/historical-maintenance'));
    for (const id of [owner, other]) await prisma.user.create({ data: { id, githubId: id, username: 'phase10-fixture' } });
    repo = (await prisma.repository.create({ data: { userId: owner, githubRepoId: BigInt(Date.now()), fullName: 'phase10/disposable', analyticsStartedAt: new Date(Date.now() - 200 * DAY) } })).id;
  });
  afterAll(async () => {
    if (prisma) { await prisma.user.deleteMany({ where: { id: { in: [owner, other] } } }); await prisma.$disconnect(); }
  });
  it('publishes completion time, fact and occurrence atomically; retries are idempotent', async () => {
    const j = await job('1'); await publish(j.id, repo, [f], result); await publish(j.id, repo, [f], result);
    const current = await prisma.analysisJob.findUniqueOrThrow({ where: { id: j.id } });
    expect(current.completedAt).not.toBeNull(); expect(current.analyticsRevision).toBe(1);
    expect(await prisma.reviewAnalyticsFact.count({ where: { analysisJobId: j.id } })).toBe(1);
    expect((await health(owner, await scope())).metrics).toMatchObject({ reviewedPRs: 1, criticalFindings: 1, averageRisk: 30 });
    // Later detail/evidence updates cannot rewrite completion-time analytics.
    await prisma.analysisJob.update({ where: { id: j.id }, data: { results: { ...result, riskV2: { ...result.riskV2, score: 99 } } } });
    expect((await health(owner, await scope())).metrics.averageRisk).toBe(30);
    await publish(j.id, repo, [], { ...result, suggestions: [], riskV2: { ...result.riskV2, score: 0 } });
    expect((await health(owner, await scope())).metrics).toMatchObject({ reviewedPRs: 1, criticalFindings: 0, averageRisk: 0 });
    expect(await prisma.reviewAnalyticsFact.count({ where: { analysisJobId: j.id } })).toBe(2);
  });
  it('does not count repeated reviews, push jobs, or failed jobs as additional PRs', async () => {
    const repeated = await job('1'); await publish(repeated.id, repo, [f], result);
    const push = await job('sha', 'PUSH'); await publish(push.id, repo, [f], result);
    const failed = await job('failed'); await prisma.analysisJob.update({ where: { id: failed.id }, data: { status: 'FAILED' } });
    expect((await health(owner, await scope())).metrics.reviewedPRs).toBe(1);
  });
  it('enforces ownership and excludes disconnected repositories', async () => {
    expect((await health(other, await scope())).metrics.repositories).toBe(0);
    await expect(health(other, await scope({ repositoryId: repo }))).rejects.toMatchObject({ status: 404 });
    await prisma.repository.update({ where: { id: repo }, data: { isActive: false } });
    expect((await health(owner, await scope())).metrics.reviewedPRs).toBe(0);
    await prisma.repository.update({ where: { id: repo }, data: { isActive: true } });
  });
  it('uses event history at the reporting boundary, excludes undo and preserves feedback separation', async () => {
    const j = await job('feedback'); await publish(j.id, repo, [f], result);
    const occurrence = await prisma.findingOccurrence.findFirstOrThrow({ where: { analysisJobId: j.id } });
    await workflow(owner, j.id, occurrence.id, 'REPORTED_FIXED', 0);
    const atFixed = await scope(); expect((await health(owner, atFixed)).metrics.developerReportedFixes).toBe(1);
    await workflow(owner, j.id, occurrence.id, 'OPEN', 1);
    expect((await health(owner, await scope())).metrics.developerReportedFixes).toBe(0);
    expect((await health(owner, atFixed)).metrics.developerReportedFixes).toBe(1);
  });
  it('dry-runs and backfills legacy records explicitly, without fabricating completion dates', async () => {
    const legacy = await prisma.analysisJob.create({ data: { repositoryId: repo, referenceId: 'legacy', eventType: 'PULL_REQUEST',
      status: 'COMPLETED', results: [f], createdAt: new Date(Date.now() - DAY) } });
    expect((await backfill()).dryRun).toBe(true);
    expect(await prisma.reviewAnalyticsFact.count({ where: { analysisJobId: legacy.id } })).toBe(0);
    await backfill({ apply: true }); await backfill({ apply: true });
    const current = await prisma.analysisJob.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(current.completedAt).toBeNull(); expect(current.results).toEqual([f]);
    const facts = await prisma.reviewAnalyticsFact.findMany({ where: { analysisJobId: legacy.id } });
    expect(facts).toHaveLength(1); expect(facts[0].timestampQuality).toBe('APPROXIMATE_CREATED_AT');
    expect(facts[0].completedAt).toEqual(legacy.createdAt);
    expect((await health(owner, await scope())).coverage.approximatePRs).toBe(1);
  });
  it('preserves half-open boundaries, as-of revisions and chart gaps', async () => {
    const s = await scope({ range: '7d' }), j = await job('boundaries');
    const data = { analysisJobId: j.id, repositoryId: repo, referenceId: 'boundaries', eventType: 'PULL_REQUEST' as const,
      findingSnapshot: 1, jobCreatedAt: j.createdAt, timestampQuality: 'EXACT', metricsVersion: METRICS_VERSION,
      riskAlgorithmVersion: RISK_ALGORITHM_VERSION, configurationSignature: 'fixture', riskScore: 60,
      criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0, infoCount: 0, securityCount: 0, testGapCount: null,
      coverage: {}, expiresAt: new Date(Date.now() + DAY) };
    await prisma.reviewAnalyticsFact.create({ data: { ...data, completedAt: s.start, artifactRevision: 1 } });
    await prisma.reviewAnalyticsFact.create({ data: { ...data, completedAt: s.end, artifactRevision: 2, riskScore: 100 } });
    const report = await health(owner, { ...s, metric: 'risk', limit: 50 });
    expect(report.reviews.items.find(r => r.jobId === j.id)?.riskScore).toBe(60);
    expect(report.trend.some(p => p.averageRisk === null)).toBe(true);
  });
  it('rolls back the completed review and occurrence publication when fact persistence fails', async () => {
    const j = await job('rollback');
    // Force a unique-key failure without injecting SQL or changing the schema.
    const template = await prisma.reviewAnalyticsFact.findFirstOrThrow({ where: { repositoryId: repo } });
    const { id: _id, ...copy } = template;
    await prisma.reviewAnalyticsFact.create({ data: { ...copy, analysisJobId: j.id, referenceId: j.referenceId, artifactRevision: 1 } });
    await expect(publish(j.id, repo, [f], result)).rejects.toThrow();
    expect((await prisma.analysisJob.findUniqueOrThrow({ where: { id: j.id } })).status).toBe('POSTING');
    expect(await prisma.findingOccurrence.count({ where: { analysisJobId: j.id } })).toBe(0);
    await prisma.reviewAnalyticsFact.deleteMany({ where: { analysisJobId: j.id } });
  });
  it('removes expired numeric facts in a bounded sweep and clears analytics on disconnect', async () => {
    const j = await job('expire'); await publish(j.id, repo, [f], result);
    await prisma.reviewAnalyticsFact.updateMany({ where: { analysisJobId: j.id }, data: { expiresAt: new Date(0) } });
    const { sweepAnalyticsOnce } = await import('../../workers/analytics-retention');
    expect(await sweepAnalyticsOnce()).toBeGreaterThan(0);
    expect(await prisma.reviewAnalyticsFact.count({ where: { analysisJobId: j.id } })).toBe(0);
    await clear(repo); expect(await prisma.reviewAnalyticsFact.count({ where: { repositoryId: repo } })).toBe(0);
    const last = await job('cascade'); await publish(last.id, repo, [f], result);
    await prisma.repository.delete({ where: { id: repo } });
    expect(await prisma.reviewAnalyticsFact.count({ where: { analysisJobId: last.id } })).toBe(0);
  });
});
