import { createHash } from 'node:crypto';
import type { AnalysisJob, Prisma } from '@prisma/client';
import { normalizeStoredSuggestions } from '../ai/finding-taxonomy';
import { SEVERITY_WEIGHTS } from '../security/risk-engine';

export const METRICS_VERSION = 'engineering_health_v1';
export const RISK_ALGORITHM_VERSION = 'risk_v2.1';
export const ANALYTICS_RETENTION_DAYS = 180; // 90 current + 90 comparison, not raw feedback retention.
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
export function stableJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return JSON.stringify(value.map(v => JSON.parse(stableJson(v))));
  if (value && typeof value === 'object') return JSON.stringify(Object.fromEntries(Object.entries(value)
    .filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, JSON.parse(stableJson(v))])));
  return JSON.stringify(value ?? null);
}
export const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');

/** Exact normalized issue+location deduplication, not semantic/fuzzy matching. */
export function extractAnalytics(results: unknown) {
  const raw = object(results);
  const findings = normalizeStoredSuggestions(Array.isArray(results) ? results : raw.suggestions);
  const groups = new Map<string, { severity: keyof typeof SEVERITY_WEIGHTS; security: boolean }>();
  for (const f of findings) {
    const key = JSON.stringify([f.filePath.replace(/\\/g, '/').replace(/^\.\//, ''), f.lineNumber, f.issue.trim().toLowerCase().replace(/\s+/g, ' ')]);
    const previous = groups.get(key);
    const security = f.agentType === 'SECURITY' || [f.source, ...(f.sources ?? [])].some(s => ['SAST', 'SECRETS', 'DEPENDENCIES'].includes(s ?? ''));
    groups.set(key, { severity: previous && SEVERITY_WEIGHTS[previous.severity] > SEVERITY_WEIGHTS[f.priority] ? previous.severity : f.priority,
      security: security || previous?.security === true });
  }
  const counts = { criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0, infoCount: 0, securityCount: 0 };
  const countKey = { CRITICAL: 'criticalCount', HIGH: 'highCount', MEDIUM: 'mediumCount', LOW: 'lowCount', INFO: 'infoCount' } as const;
  for (const g of groups.values()) { counts[countKey[g.severity]]++; if (g.security) counts.securityCount++; }
  const gaps = object(raw.testGaps);
  const scenarios = Array.isArray(gaps.scenarios) ? gaps.scenarios : [];
  const gapsAnalyzed = gaps.analyzed === true && Array.isArray(gaps.scenarios);
  const testGapCount = gapsAnalyzed ? new Set(scenarios.filter(s => s && typeof s.filePath === 'string' &&
    typeof s.scenario === 'string' && Number.isSafeInteger(s.lineNumber)).map(s => JSON.stringify([
      s.filePath.replace(/\\/g, '/'), s.lineNumber, s.scenario.trim().toLowerCase().replace(/\s+/g, ' '),
    ]))).size : null;
  const risk = object(raw.riskV2), coverage = object(risk.coverage);
  const scan = (v: unknown) => ['FULL', 'PARTIAL', 'NOT_RUN'].includes(v as string) ? v as string : 'NOT_RUN';
  const security = object(coverage.security);
  const normalizedCoverage = { security: { SAST: scan(security.SAST), SECRETS: scan(security.SECRETS), DEPENDENCIES: scan(security.DEPENDENCIES) },
    context: ['AVAILABLE', 'PARTIAL', 'NOT_RUN'].includes(coverage.context) ? coverage.context as string : 'NOT_RUN',
    testGaps: gapsAnalyzed ? gaps.evidence && !gaps.evidence.incomplete && !gaps.evidence.treeTruncated ? 'AVAILABLE' : 'PARTIAL' : 'NOT_RUN',
    confidence: ['LOW', 'MEDIUM', 'HIGH'].includes(coverage.confidence) ? coverage.confidence as string : 'LOW',
    includedFiles: Number.isSafeInteger(coverage.includedFiles) && coverage.includedFiles >= 0 ? coverage.includedFiles as number : 0,
    ignoredFiles: Number.isSafeInteger(coverage.ignoredFiles) && coverage.ignoredFiles >= 0 ? coverage.ignoredFiles as number : 0,
    rulesSkipped: Number.isSafeInteger(coverage.rules?.skipped) && coverage.rules.skipped >= 0 ? coverage.rules.skipped as number : 0,
    behavioralExecuted: Number.isSafeInteger(coverage.behavioral?.executed) && coverage.behavioral.executed >= 0 ? coverage.behavioral.executed as number : 0,
    behavioralIncomplete: !coverage.behavioral || !coverage.behavioral.generated || coverage.behavioral.notRun > 0 || coverage.behavioral.timedOut > 0 || coverage.behavioral.errors > 0,
  };
  const riskScore = risk.version === 2 && risk.direction === 'HIGHER_IS_RISKIER' && typeof risk.score === 'number' &&
    Number.isFinite(risk.score) && risk.score >= 0 && risk.score <= 100 ? risk.score : null;
  const configuration = object(raw.analyticsConfiguration);
  return { ...counts, testGapCount, riskScore, coverage: normalizedCoverage,
    configurationSignature: Object.keys(configuration).length ? digest(configuration) : 'UNKNOWN',
    riskAlgorithmVersion: risk.version === 2 && configuration.riskAlgorithmVersion === RISK_ALGORITHM_VERSION ? RISK_ALGORITHM_VERSION : 'UNKNOWN' };
}

/** Caller holds repository lock. Review result, occurrence snapshot and fact commit together. */
export async function publishReviewAnalytics(tx: Prisma.TransactionClient, job: AnalysisJob, results: unknown,
  findingSnapshot: number, quality: 'EXACT' | 'APPROXIMATE_CREATED_AT' = 'EXACT') {
  const metrics = extractAnalytics(results);
  const hash = digest({ metrics, findingSnapshot, quality });
  if (job.analyticsHash === hash) return;
  const completedAt = quality === 'EXACT' ? new Date() : job.createdAt;
  const artifactRevision = (job.analyticsRevision ?? 0) + 1;
  await tx.reviewAnalyticsFact.create({ data: { ...metrics, analysisJobId: job.id, repositoryId: job.repositoryId,
    referenceId: job.referenceId, eventType: job.eventType, artifactRevision, findingSnapshot, completedAt,
    jobCreatedAt: job.createdAt, timestampQuality: quality, metricsVersion: METRICS_VERSION,
    expiresAt: new Date(completedAt.getTime() + ANALYTICS_RETENTION_DAYS * 86400000) } });
  await tx.analysisJob.update({ where: { id: job.id }, data: { analyticsHash: hash, analyticsRevision: artifactRevision,
    ...(quality === 'EXACT' ? { completedAt } : {}) } });
}
