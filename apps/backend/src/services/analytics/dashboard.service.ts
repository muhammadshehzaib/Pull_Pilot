import { Prisma } from '@prisma/client';
import prisma from '../../config/prisma';
import { historyCutoff } from '../historical/state';
import { average, compareRisk, DashboardError, exact, representatives, riskTrend, scored, type Scope } from './model';

const MAX_FACTS = 10_000, MAX_EVENTS = 50_000;
/** Bounded, repeatable read. Scope is ALWAYS derived from the authenticated actor. */
export async function engineeringHealth(actorId: string, scope: Scope) {
  return prisma.$transaction(async tx => {
    const owned = { userId: actorId, isActive: true };
    if (scope.repositoryId && !await tx.repository.findFirst({ where: { ...owned, id: scope.repositoryId }, select: { id: true } }))
      throw new DashboardError(404, 'Repository unavailable');
    const repository = { ...owned, ...(scope.repositoryId ? { id: scope.repositoryId } : {}) };
    const [repositories, repositoryCount, facts, legacyJobs] = await Promise.all([
      tx.repository.findMany({ where: repository, select: { id: true, fullName: true, analyticsStartedAt: true }, orderBy: { fullName: 'asc' }, take: 501 }),
      tx.repository.count({ where: repository }),
      tx.reviewAnalyticsFact.findMany({ where: { repository, eventType: 'PULL_REQUEST',
        completedAt: { gte: scope.previousStart, lt: scope.end }, expiresAt: { gt: new Date() } },
        orderBy: [{ completedAt: 'desc' }, { artifactRevision: 'desc' }, { id: 'desc' }], take: MAX_FACTS + 1 }),
      tx.analysisJob.count({ where: { repository, eventType: 'PULL_REQUEST', status: 'COMPLETED', analyticsRevision: 0 } }),
    ]);
    const limited = facts.length > MAX_FACTS;
    const current = limited ? [] : representatives(facts, scope.start, scope.end);
    const previous = limited ? [] : representatives(facts, scope.previousStart, scope.start);
    const precise = current.filter(exact);
    const scoredFacts = precise.filter(scored);
    const hasUnknownDates = legacyJobs > 0 || current.some(f => !exact(f));
    const countsAvailable = !limited && !(precise.length === 0 && hasUnknownDates);
    const sum = (key: 'criticalCount' | 'securityCount' | 'testGapCount') => precise.reduce((total, f) => total + (f[key] ?? 0), 0);
    // Raw workflow evidence has a separate 90-day retention policy. Do not prolong it through analytics.
    const eventRows = precise.length ? await tx.findingWorkflowEvent.findMany({ where: {
      createdAt: { lt: scope.end }, workflow: { occurrence: { repository, analysisJobId: { in: precise.map(f => f.analysisJobId) } } },
    }, select: { workflowId: true, status: true, revision: true, createdAt: true,
      workflow: { select: { occurrence: { select: { analysisJobId: true, snapshotKey: true, analysisJob: { select: { createdAt: true } } } } } } },
    orderBy: [{ createdAt: 'desc' }, { revision: 'desc' }], take: MAX_EVENTS + 1 }) : [];
    const seen = new Set<string>(), fixJobs = new Set<string>();
    let reportedFixes = 0;
    const snapshotByJob = new Map(precise.map(f => [f.analysisJobId, f.findingSnapshot]));
    const cutoff = historyCutoff();
    for (const e of eventRows) {
      if (seen.has(e.workflowId)) continue;
      seen.add(e.workflowId);
      const o = e.workflow.occurrence;
      if (e.status === 'REPORTED_FIXED' && e.createdAt >= scope.start && o.analysisJob.createdAt >= cutoff &&
        o.snapshotKey.startsWith(`${o.analysisJobId}:${snapshotByJob.get(o.analysisJobId)}:`)) {
        reportedFixes++; fixJobs.add(o.analysisJobId);
      }
    }
    const fixCoverageComplete = eventRows.length <= MAX_EVENTS && precise.every(f => f.jobCreatedAt >= cutoff) && !hasUnknownDates && !limited;
    const gapScanned = precise.filter(f => f.testGapCount !== null).length;
    const partialEvidencePRs = precise.filter(f => {
      const c = f.coverage as Record<string, any>;
      return c.context !== 'AVAILABLE' || c.testGaps !== 'AVAILABLE' || !c.includedFiles || c.rulesSkipped > 0 ||
        c.behavioralIncomplete !== false || ['SAST', 'SECRETS', 'DEPENDENCIES'].some(p => c.security?.[p] !== 'FULL');
    }).length;
    const trackingStart = repositories.reduce((date, r) => r.analyticsStartedAt > date ? r.analyticsStartedAt : date, new Date(0));
    const comparison = compareRisk(current, previous, trackingStart, scope.previousStart);
    if (legacyJobs > 0 || repositoryCount > 500) Object.assign(comparison, { available: false,
      reason: legacyJobs > 0 ? 'Legacy reviews have unknown completion dates; the comparison sample may be incomplete.' :
        'Tracking metadata is bounded to 500 repositories; select a repository for comparison.', percentageChange: null });
    if (limited) Object.assign(comparison, { available: false, reason: 'Query limit reached; narrow the repository or date filter.', percentageChange: null });
    const names = new Map(repositories.map(r => [r.id, r.fullName]));
    const reviewRows = precise.map(f => ({ jobId: f.analysisJobId, repositoryId: f.repositoryId,
      repository: names.get(f.repositoryId) ?? 'Connected repository', referenceId: f.referenceId,
      completedAt: f.completedAt.toISOString(), criticalCount: f.criticalCount, securityCount: f.securityCount,
      testGapCount: f.testGapCount, riskScore: scored(f) ? f.riskScore : null, reportedFixed: fixJobs.has(f.analysisJobId),
      coverage: f.coverage, artifactRevision: f.artifactRevision }));
    const filtered = reviewRows.filter(f => scope.metric === 'all' || scope.metric === 'critical' && f.criticalCount > 0 ||
      scope.metric === 'security' && f.securityCount > 0 || scope.metric === 'testGaps' && (f.testGapCount ?? 0) > 0 ||
      scope.metric === 'risk' && f.riskScore !== null || scope.metric === 'reportedFixes' && f.reportedFixed);
    const paginate = <T>(rows: T[]) => ({ items: rows.slice((scope.page - 1) * scope.limit, scope.page * scope.limit),
      pagination: { page: scope.page, limit: scope.limit, total: rows.length, totalPages: Math.ceil(rows.length / scope.limit) } });
    const breakdown = repositories.slice(0, 500).map(r => {
      const rows = precise.filter(f => f.repositoryId === r.id);
      return { id: r.id, fullName: r.fullName, reviewedPRs: countsAvailable ? rows.length : null,
        criticalFindings: countsAvailable ? rows.reduce((n, f) => n + f.criticalCount, 0) : null,
        securityFindings: countsAvailable ? rows.reduce((n, f) => n + f.securityCount, 0) : null,
        averageRisk: average(rows).value, scoredPRs: rows.filter(scored).length };
    });
    return { version: 1, scope: { range: scope.range, bucket: scope.bucket, repositoryId: scope.repositoryId ?? null,
      start: scope.start.toISOString(), end: scope.end.toISOString(), previousStart: scope.previousStart.toISOString(), timezone: 'UTC' },
      generatedAt: new Date().toISOString(),
      metrics: { repositories: repositoryCount, reviewedPRs: countsAvailable ? precise.length : null,
        criticalFindings: countsAvailable ? sum('criticalCount') : null,
        securityFindings: countsAvailable ? sum('securityCount') : null,
        suggestedTestGaps: countsAvailable && gapScanned > 0 ? sum('testGapCount') : null,
        developerReportedFixes: fixCoverageComplete ? reportedFixes : null,
        averageRisk: average(precise).value },
      coverage: { capturedPRs: precise.length, scoredPRs: scoredFacts.length, testGapScannedPRs: gapScanned,
        partialEvidencePRs,
        legacyJobsWithoutCompletionDate: legacyJobs, approximatePRs: current.filter(f => !exact(f)).length,
        unscoredPRs: precise.length - scoredFacts.length, fixCoverageComplete, workflowQueryLimited: eventRows.length > MAX_EVENTS,
        queryLimited: limited, repositoryListLimited: repositories.length > 500, trackingStartedAt: trackingStart.toISOString(),
        partial: limited || hasUnknownDates || partialEvidencePRs > 0 || gapScanned < precise.length || scoredFacts.length < precise.length || !fixCoverageComplete },
      comparison, trend: limited ? [] : riskTrend(facts, scope), repositories: paginate(breakdown),
      repositoryOptions: repositories.slice(0, 500).map(r => ({ id: r.id, fullName: r.fullName })), reviews: paginate(filtered) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000, maxWait: 5_000 });
}
