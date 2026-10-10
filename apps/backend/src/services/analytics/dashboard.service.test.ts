import { beforeEach, describe, expect, it, vi } from 'vitest';
import prisma from '../../config/prisma';
import { engineeringHealth } from './dashboard.service';
import { parseScope } from './model';
import { METRICS_VERSION, RISK_ALGORITHM_VERSION } from './facts';

vi.mock('../../config/prisma', () => {
  const db: any = { repository: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    reviewAnalyticsFact: { findMany: vi.fn() }, analysisJob: { count: vi.fn() }, findingWorkflowEvent: { findMany: vi.fn() } };
  db.$transaction = vi.fn(async (fn: any) => fn(db)); return { default: db };
});
const db = prisma as any;
let scope: ReturnType<typeof parseScope>, rows: any[];
beforeEach(() => {
  vi.clearAllMocks(); scope = parseScope({ range: '7d' });
  rows = [{ id: 'fact', analysisJobId: 'job', repositoryId: 'repo', referenceId: '10', completedAt: new Date(Date.now() - 1000),
    jobCreatedAt: new Date(), findingSnapshot: 1, artifactRevision: 1, timestampQuality: 'EXACT', metricsVersion: METRICS_VERSION,
    riskAlgorithmVersion: RISK_ALGORITHM_VERSION, configurationSignature: 'config', riskScore: 20, coverage: {},
    criticalCount: 1, securityCount: 2, testGapCount: 3 }];
  db.repository.findFirst.mockResolvedValue({ id: 'repo' });
  db.repository.findMany.mockResolvedValue([{ id: 'repo', fullName: 'owner/repo', analyticsStartedAt: new Date(0) }]);
  db.repository.count.mockResolvedValue(1); db.reviewAnalyticsFact.findMany.mockImplementation(async () => rows);
  db.analysisJob.count.mockResolvedValue(0); db.findingWorkflowEvent.findMany.mockResolvedValue([]);
});
const event = (revision: number, status: string) => ({ workflowId: 'wf', status, revision, createdAt: new Date(Date.now() - 100),
  workflow: { occurrence: { analysisJobId: 'job', snapshotKey: 'job:1:hash', analysisJob: { createdAt: new Date() } } } });
describe('tenant-scoped engineering health reads', () => {
  it('authorizes every fact, legacy count, repository and workflow read', async () => {
    const health = await engineeringHealth('owner', scope);
    expect(health.metrics).toMatchObject({ reviewedPRs: 1, criticalFindings: 1, securityFindings: 2, suggestedTestGaps: 3, averageRisk: 20 });
    for (const method of [db.reviewAnalyticsFact.findMany, db.analysisJob.count]) expect(method).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ repository: { userId: 'owner', isActive: true }, eventType: 'PULL_REQUEST' }) }));
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: 'RepeatableRead', timeout: 15000 }));
    expect(db.findingWorkflowEvent.findMany.mock.calls[0][0].where.workflow.occurrence.repository).toEqual({ userId: 'owner', isActive: true });
  });
  it('rejects foreign or disconnected repositories before querying facts', async () => {
    db.repository.findFirst.mockResolvedValue(null);
    await expect(engineeringHealth('other', parseScope({ repositoryId: 'repo' }))).rejects.toMatchObject({ status: 404 });
    expect(db.reviewAnalyticsFact.findMany).not.toHaveBeenCalled();
  });
  it('handles latest workflow events, undo/reopen, and duplicate revisions without inflating fixes', async () => {
    db.findingWorkflowEvent.findMany.mockResolvedValue([event(2, 'OPEN'), event(1, 'REPORTED_FIXED')]);
    expect((await engineeringHealth('owner', scope)).metrics.developerReportedFixes).toBe(0);
    db.findingWorkflowEvent.findMany.mockResolvedValue([event(2, 'REPORTED_FIXED'), event(2, 'REPORTED_FIXED')]);
    expect((await engineeringHealth('owner', scope)).metrics.developerReportedFixes).toBe(1);
  });
  it('does not transfer fixed status to regenerated findings', async () => {
    rows[0].findingSnapshot = 2; db.findingWorkflowEvent.findMany.mockResolvedValue([event(1, 'REPORTED_FIXED')]);
    expect((await engineeringHealth('owner', scope)).metrics.developerReportedFixes).toBe(0);
  });
  it('marks expired workflow coverage unavailable, not zero', async () => {
    rows[0].jobCreatedAt = new Date(0);
    expect((await engineeringHealth('owner', scope)).metrics.developerReportedFixes).toBeNull();
  });
  it('keeps unknown legacy dates out of precise metrics', async () => {
    rows[0].timestampQuality = 'APPROXIMATE_CREATED_AT';
    const health = await engineeringHealth('owner', scope);
    expect(health.metrics.reviewedPRs).toBeNull(); expect(health.metrics.averageRisk).toBeNull();
    expect(health.coverage.approximatePRs).toBe(1); expect(health.coverage.partial).toBe(true);
  });
  it('keeps absence different from zero and drilldown denominators aligned', async () => {
    rows[0].testGapCount = null; rows[0].riskScore = null;
    const health = await engineeringHealth('owner', { ...scope, metric: 'risk' });
    expect(health.metrics.suggestedTestGaps).toBeNull(); expect(health.metrics.averageRisk).toBeNull();
    expect(health.reviews.pagination.total).toBe(0); expect(health.coverage.unscoredPRs).toBe(1);
  });
  it('fails closed on bounded query overflow instead of presenting truncated totals', async () => {
    rows = Array.from({ length: 10001 }, (_, i) => ({ ...rows[0], id: String(i), referenceId: String(i) }));
    const health = await engineeringHealth('owner', scope);
    expect(health.coverage.queryLimited).toBe(true); expect(health.metrics.reviewedPRs).toBeNull(); expect(health.trend).toEqual([]);
  });
  it('does not compare an incomplete unknown-date legacy sample', async () => {
    db.analysisJob.count.mockResolvedValue(1);
    const health = await engineeringHealth('owner', scope);
    expect(health.comparison).toMatchObject({ available: false, percentageChange: null });
    expect(health.comparison.reason).toContain('unknown completion dates');
  });
});
