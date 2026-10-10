import type { ReviewAnalyticsFact } from '@prisma/client';
import { digest, METRICS_VERSION, RISK_ALGORITHM_VERSION } from './facts';

export const DAY = 86_400_000;
export type Metric = 'all' | 'critical' | 'security' | 'testGaps' | 'risk' | 'reportedFixes';
export class DashboardError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function parseScope(query: Record<string, unknown>, now = new Date()) {
  const range = query.range ?? '30d', bucket = query.bucket ?? 'day';
  if (!['7d', '30d', '90d'].includes(range as string) || !['day', 'week'].includes(bucket as string))
    throw new DashboardError(400, 'Invalid range or bucket');
  const repositoryId = query.repositoryId;
  if (repositoryId !== undefined && (typeof repositoryId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(repositoryId)))
    throw new DashboardError(400, 'Invalid repository');
  const asOf = query.asOf;
  const end = asOf === undefined ? now : typeof asOf === 'string' && /^\d{4}-\d\d-\d\dT/.test(asOf) ? new Date(asOf) : new Date(NaN);
  if (!Number.isFinite(end.getTime()) || end > now || now.getTime() - end.getTime() > DAY)
    throw new DashboardError(400, 'Snapshot expired or invalid; refresh the dashboard');
  const days = Number((range as string).slice(0, -1));
  const start = new Date(end.getTime() - days * DAY), previousStart = new Date(start.getTime() - days * DAY);
  const integer = (value: unknown, fallback: number, max: number) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > max)
      throw new DashboardError(400, 'Invalid pagination');
    return Number(value);
  };
  const metric = query.metric ?? 'all';
  if (!['all', 'critical', 'security', 'testGaps', 'risk', 'reportedFixes'].includes(metric as string))
    throw new DashboardError(400, 'Invalid metric');
  return { range: range as string, bucket: bucket as 'day' | 'week', repositoryId: repositoryId as string | undefined,
    start, end, previousStart, page: integer(query.page, 1, 1000), limit: integer(query.limit, 10, 50), metric: metric as Metric };
}
export type Scope = ReturnType<typeof parseScope>;
export function bucketStart(date: Date, bucket: 'day' | 'week') {
  const d = new Date(date); d.setUTCHours(0, 0, 0, 0);
  if (bucket === 'week') d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d;
}
/** Input is newest first, including revisions. One artifact per PR per requested period/bucket. */
export function representatives<T extends ReviewAnalyticsFact>(facts: T[], start: Date, end: Date, bucket?: 'day' | 'week'): T[] {
  const seen = new Set<string>();
  return facts.filter(f => {
    if (f.completedAt < start || f.completedAt >= end) return false;
    const key = JSON.stringify([f.repositoryId, f.referenceId, bucket ? bucketStart(f.completedAt, bucket).toISOString() : 'period']);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
export const exact = (f: ReviewAnalyticsFact) => f.timestampQuality === 'EXACT' && f.metricsVersion === METRICS_VERSION;
export const scored = (f: ReviewAnalyticsFact) => exact(f) && f.riskAlgorithmVersion === RISK_ALGORITHM_VERSION &&
  f.configurationSignature !== 'UNKNOWN' && f.riskScore !== null && Number.isFinite(f.riskScore) && f.riskScore >= 0 && f.riskScore <= 100;
export function average(facts: ReviewAnalyticsFact[]) {
  const values = facts.filter(scored);
  return { value: values.length ? values.reduce((sum, f) => sum + f.riskScore!, 0) / values.length : null, scoredPRs: values.length };
}
const profile = (f: ReviewAnalyticsFact) => {
  const c = f.coverage as Record<string, any>;
  return digest({ config: f.configurationSignature, algorithm: f.riskAlgorithmVersion, security: c.security,
    context: c.context, testGaps: c.testGaps, hasIgnoredFiles: c.ignoredFiles > 0, hasSkippedRules: c.rulesSkipped > 0,
    behavioralExecuted: c.behavioralExecuted > 0, behavioralIncomplete: c.behavioralIncomplete });
};
export function compareRisk(current: ReviewAnalyticsFact[], previous: ReviewAnalyticsFact[], trackingStart: Date, previousStart: Date) {
  const a = average(current), b = average(previous);
  let reason: string | null = null;
  if (trackingStart > previousStart) reason = 'Analytics tracking does not cover both full periods.';
  else if (a.scoredPRs < 10 || b.scoredPRs < 10) reason = 'At least 10 scored PRs are required in each period.';
  else if (a.scoredPRs !== current.length || b.scoredPRs !== previous.length) reason = 'Some PRs have missing or incompatible scores.';
  else {
    const signatures = (rows: ReviewAnalyticsFact[]) => [...new Set(rows.map(f => `${f.repositoryId}:${profile(f)}`))].sort();
    if (JSON.stringify(signatures(current)) !== JSON.stringify(signatures(previous)))
      reason = 'Repository cohort, scoring configuration, or scan coverage differs between periods.';
    else if (b.value === 0) reason = 'The previous average is zero; percentage change is undefined.';
  }
  return { available: reason === null, reason, currentAverage: a.value, previousAverage: b.value,
    currentScoredPRs: a.scoredPRs, previousScoredPRs: b.scoredPRs,
    percentageChange: reason === null ? (a.value! - b.value!) / b.value! * 100 : null };
}
export function riskTrend(facts: ReviewAnalyticsFact[], scope: Scope) {
  const rows = representatives(facts, scope.start, scope.end, scope.bucket);
  const points = [];
  const step = scope.bucket === 'week' ? 7 * DAY : DAY;
  for (let t = bucketStart(scope.start, scope.bucket).getTime(); t < scope.end.getTime(); t += step) {
    const selected = rows.filter(f => bucketStart(f.completedAt, scope.bucket).getTime() === t);
    const avg = average(selected);
    points.push({ start: new Date(Math.max(t, scope.start.getTime())).toISOString(),
      end: new Date(Math.min(t + step, scope.end.getTime())).toISOString(), averageRisk: avg.value,
      scoredPRs: avg.scoredPRs, reviewedPRs: selected.filter(exact).length,
      partialBucket: t < scope.start.getTime() || t + step > scope.end.getTime() });
  }
  return points;
}
