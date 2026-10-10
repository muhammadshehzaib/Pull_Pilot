import type { RiskReport } from './security';
export interface ExplainableRiskReport extends RiskReport {
  version: 2;
  direction: 'HIGHER_IS_RISKIER';
  enforcement: 'ADVISORY';
  thresholds: { review: number; block: number };
  unclampedScore: number;
  factors: { id: string; kind: string; points: number; filePath?: string; lineNumber?: number; sources: string[]; corroborated: boolean; explanation: string }[];
  factorsOmitted: number;
  duplicateCount: number;
  coverage: { scope: string; includedFiles: number; ignoredFiles: number; security: Record<string, string>; rules: { executed: number; failed: number; skipped: number }; context: string; testGaps: string; behavioral: { generated: number; executed: number; verified: number; failed: number; notRun: number; timedOut: number; errors: number }; confidence: string; missingEvidence: string[] };
}
/** Unsupported/partial versions fall back to the legacy card, never a fake zero. */
export function normalizeExplainableRisk(value: unknown): ExplainableRiskReport | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as ExplainableRiskReport;
  if (r.version !== 2 || r.direction !== 'HIGHER_IS_RISKIER' || r.enforcement !== 'ADVISORY' || typeof r.score !== 'number' || !Number.isFinite(r.score) || r.score < 0 || r.score > 100 || !['SAFE', 'REVIEW', 'BLOCK'].includes(r.verdict) || !r.coverage || !r.coverage.behavioral || !r.coverage.rules || !r.coverage.security || !Array.isArray(r.coverage.missingEvidence) || !r.coverage.missingEvidence.every(v => typeof v === 'string') || !r.thresholds || typeof r.thresholds.review !== 'number' || typeof r.thresholds.block !== 'number' || !Array.isArray(r.factors) || !Array.isArray(r.reasons)) return null;
  if (r.factors.some(f => !f || typeof f.explanation !== 'string' || !Number.isFinite(f.points) || !Array.isArray(f.sources) || !f.sources.every(s => typeof s === 'string'))) return null;
  return r;
}
