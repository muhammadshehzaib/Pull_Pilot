import { describe, expect, it } from 'vitest';
import type { ReviewAnalyticsFact } from '@prisma/client';
import { digest, extractAnalytics, METRICS_VERSION, RISK_ALGORITHM_VERSION } from './facts';
import { average, bucketStart, compareRisk, DAY, parseScope, representatives, riskTrend } from './model';

export const now = new Date('2026-10-11T12:00:00Z');
export function fact(overrides: Partial<ReviewAnalyticsFact> = {}): ReviewAnalyticsFact {
  return { id: 'fact', repositoryId: 'repo', analysisJobId: 'job', artifactRevision: 1, findingSnapshot: 1,
    referenceId: '1', eventType: 'PULL_REQUEST', completedAt: now, jobCreatedAt: now, expiresAt: new Date(now.getTime() + 180 * DAY),
    timestampQuality: 'EXACT', metricsVersion: METRICS_VERSION, riskAlgorithmVersion: RISK_ALGORITHM_VERSION,
    configurationSignature: 'config', riskScore: 40, criticalCount: 1, highCount: 0, mediumCount: 0, lowCount: 0, infoCount: 0,
    securityCount: 1, testGapCount: 0, coverage: { security: { SAST: 'FULL' }, context: 'AVAILABLE', testGaps: 'AVAILABLE' }, ...overrides };
}
const finding = { filePath: 'src/a.ts', lineNumber: 1, agentType: 'BUG', priority: 'HIGH', issue: ' Missing guard ', suggestion: 'Guard null' };

describe('versioned engineering health metrics', () => {
  it('deduplicates exact issue/location across detectors and uses strongest severity', () => {
    expect(extractAnalytics({ suggestions: [finding, { ...finding, filePath: './src/a.ts', issue: 'missing  guard', agentType: 'SECURITY', priority: 'CRITICAL', source: 'SAST' }] }))
      .toMatchObject({ criticalCount: 1, highCount: 0, securityCount: 1, riskScore: null, testGapCount: null });
  });
  it('preserves case-sensitive paths and distinct locations', () => {
    expect(extractAnalytics([finding, { ...finding, filePath: 'src/A.ts' }, { ...finding, lineNumber: 2 }]).highCount).toBe(3);
  });
  it('normalizes legacy severity aliases without rewriting records', () => {
    const input = [{ ...finding, priority: 'blocker' }];
    expect(extractAnalytics(input).criticalCount).toBe(1); expect(input[0].priority).toBe('blocker');
    expect(extractAnalytics(null).riskScore).toBeNull();
  });
  it('never turns absent or malformed test-gap evidence into a successful zero scan', () => {
    expect(extractAnalytics({ testGaps: { analyzed: false, scenarios: [] } }).testGapCount).toBeNull();
    expect(extractAnalytics({ testGaps: { analyzed: true } }).testGapCount).toBeNull();
    expect(extractAnalytics({ testGaps: { analyzed: true, scenarios: [] } }).testGapCount).toBe(0);
  });
  it.each([-1, 101, NaN, Infinity, '0'])('rejects invalid risk score %s', score => {
    expect(extractAnalytics({ riskV2: { version: 2, direction: 'HIGHER_IS_RISKIER', score } }).riskScore).toBeNull();
  });
  it('does not infer comparability from legacy risk or an unversioned configuration', () => {
    expect(extractAnalytics({ risk: { score: 1 } }).riskScore).toBeNull();
    expect(extractAnalytics({ riskV2: { version: 2, direction: 'HIGHER_IS_RISKIER', score: 0 } }).riskAlgorithmVersion).toBe('UNKNOWN');
    expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }));
    expect(digest({ ruleUpdatedAt: new Date(0) })).not.toBe(digest({ ruleUpdatedAt: new Date(1) }));
    expect(digest({ ruleUpdatedAt: new Date(0) })).toBe(digest({ ruleUpdatedAt: new Date(0).toISOString() }));
  });
});
describe('reporting windows and comparison guards', () => {
  it.each([{ range: 'all' }, { bucket: 'month' }, { page: '-1' }, { limit: '1000' }, { metric: 'anything' },
    { repositoryId: ['repo'] }, { asOf: '2026-10-12T00:00:00Z' }, { asOf: '2026-10-11T10:00:00' }, { asOf: 'bad' }])('rejects unbounded/invalid filters %j', query => {
    expect(() => parseScope(query, now)).toThrow();
  });
  it('uses trailing equal-length half-open UTC periods and Monday weeks', () => {
    const scope = parseScope({ range: '7d' }, now);
    expect(scope.start.toISOString()).toBe('2026-10-04T12:00:00.000Z');
    expect(scope.start.getTime() - scope.previousStart.getTime()).toBe(7 * DAY);
    expect(bucketStart(now, 'week').toISOString()).toBe('2026-10-05T00:00:00.000Z');
    const rows = [fact({ id: 'at-end' }), fact({ id: 'at-start', completedAt: scope.start })];
    expect(representatives(rows, scope.start, scope.end).map(f => f.id)).toEqual(['at-start']);
  });
  it('selects latest completed artifact per PR per period, but separately per bucket', () => {
    const scope = parseScope({ range: '7d' }, now);
    const rows = [fact({ completedAt: new Date(now.getTime() - DAY) }), fact({ id: 'retry', completedAt: new Date(now.getTime() - 2 * DAY) })];
    expect(representatives(rows, scope.start, scope.end)).toHaveLength(1);
    expect(representatives(rows, scope.start, scope.end, 'day')).toHaveLength(2);
    const trend = riskTrend(rows, scope); expect(trend.some(p => p.averageRisk === null)).toBe(true);
    expect(trend.filter(p => p.averageRisk !== null)).toHaveLength(2);
  });
  it('excludes missing, incompatible and approximate scores but includes actual zero', () => {
    expect(average([fact({ riskScore: 0 }), fact({ riskScore: null }), fact({ riskAlgorithmVersion: 'UNKNOWN' }),
      fact({ timestampQuality: 'APPROXIMATE_CREATED_AT' })])).toEqual({ value: 0, scoredPRs: 1 });
  });
  const sample = (score: number) => Array.from({ length: 10 }, (_, i) => fact({ referenceId: String(i), riskScore: score }));
  const before = new Date(0);
  it('reports a defensible indicated-risk change only for comparable samples', () => {
    expect(compareRisk(sample(30), sample(40), before, now)).toMatchObject({ available: true, percentageChange: -25 });
  });
  it.each(['sample', 'tracking', 'zero', 'cohort', 'config', 'coverage', 'missing'])('blocks invalid comparison: %s', reason => {
    let a = sample(30), b = sample(40), tracking = before;
    if (reason === 'sample') a = a.slice(1);
    if (reason === 'tracking') tracking = new Date(now.getTime() + 1);
    if (reason === 'zero') b = sample(0);
    if (reason === 'cohort') a[0].repositoryId = 'other';
    if (reason === 'config') a[0].configurationSignature = 'other';
    if (reason === 'coverage') a[0].coverage = { context: 'NOT_RUN' };
    if (reason === 'missing') a[0].riskScore = null;
    expect(compareRisk(a, b, tracking, now)).toMatchObject({ available: false, percentageChange: null });
  });
});
