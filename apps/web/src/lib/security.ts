/**
 * Security-layer vocabulary for the web app.
 *
 * Mirrors `apps/backend/src/services/security/` (probe-types.ts, risk-engine.ts)
 * and the Prisma `SecurityCheck` model. Types live beside `lib/review.ts`'s
 * because they share `Priority` and `AgentType`, and it keeps the boundary
 * safety story the same: the API can hand the UI a probe or verdict this build
 * has never heard of, and every renderer still produces a readable label.
 */

export type SecurityProbe = 'SAST' | 'SECRETS' | 'DEPENDENCIES';

export type SecurityCheckStatus = 'PASS' | 'FAIL' | 'SKIPPED' | 'DEGRADED';

export type RiskVerdict = 'BLOCK' | 'REVIEW' | 'SAFE';

/** One outcome row per security probe per job, mirroring `RuleCheck`. */
export interface SecurityCheck {
  id: string;
  probe: SecurityProbe;
  ruleKey: string;
  ruleName: string;
  status: SecurityCheckStatus;
  findingCount: number;
  /** Present for DEGRADED (why coverage was reduced) or SKIPPED (why nothing ran). */
  detail?: string | null;
  createdAt: string;
}

/**
 * Combined output of the risk engine, stored on the job's results blob by the
 * worker and surfaced via `GET /api/jobs/:id`.
 */
export interface RiskReport {
  score: number;
  verdict: RiskVerdict;
  blockingCount: number;
  securityFindingCount: number;
  corroboratedCount: number;
  categories: string[];
  byProbe: Record<SecurityProbe, number>;
  reasons: string[];
}

export const PROBE_LABELS: Record<SecurityProbe, string> = {
  SAST: 'Static analysis',
  SECRETS: 'Secrets',
  DEPENDENCIES: 'Dependencies',
};

/*
 * Unlike the rules engine, a security probe can be SKIPPED because there was
 * nothing to scan (the diff had no package manifests, say), or DEGRADED because
 * an optional input (Semgrep, live OSV.dev) was unavailable. The row labels
 * describe the probe's own coverage, not the model's opinion.
 */
export const SECURITY_CHECK_STATUS_LABELS: Record<SecurityCheckStatus, string> = {
  PASS: 'Passed',
  FAIL: 'Failed',
  SKIPPED: 'Skipped',
  DEGRADED: 'Partial',
};

export const SECURITY_CHECK_STATUS_COLORS: Record<SecurityCheckStatus, string> = {
  PASS: 'var(--success)',
  FAIL: 'var(--danger)',
  SKIPPED: 'var(--text-secondary)',
  DEGRADED: 'var(--warning)',
};

export const PROBE_COLORS: Record<SecurityProbe, string> = {
  SAST: 'var(--accent)',
  SECRETS: '#dc2626',
  DEPENDENCIES: '#d97706',
};

/** Probe label for an arbitrary string. Unknown values read as the raw text. */
export function probeLabel(probe: string): string {
  return PROBE_LABELS[probe as SecurityProbe] ?? probe;
}

export const VERDICT_LABELS: Record<RiskVerdict, string> = {
  BLOCK: 'Block',
  REVIEW: 'Review',
  SAFE: 'Safe',
};

export const VERDICT_COLORS: Record<RiskVerdict, string> = {
  BLOCK: 'var(--danger)',
  REVIEW: 'var(--warning)',
  SAFE: 'var(--success)',
};

/** Verdict label for an arbitrary string. Unknown values read as the raw text. */
export function verdictLabel(verdict: string): string {
  return VERDICT_LABELS[verdict as RiskVerdict] ?? verdict;
}

/**
 * Score bands, mirroring the backend's `assessRisk` thresholds verbatim so the
 * gauge and the engine never disagree about what a score means.
 */
export function riskTone(score: number): 'block' | 'review' | 'safe' {
  if (score >= 75) return 'block';
  if (score >= 25) return 'review';
  return 'safe';
}

export function isBlockingVerdict(verdict: RiskVerdict): boolean {
  return verdict === 'BLOCK';
}

/**
 * Renders the by-probe tallies with SAFE neighbours as `0`. The card wants a
 * row per probe whether or not a probe fired, and the backend always writes an
 * all-zero object, so this mainly guards cheaply against an unexpected shape.
 */
export function probeTally(report: RiskReport): { probe: SecurityProbe; count: number }[] {
  const order: SecurityProbe[] = ['SAST', 'SECRETS', 'DEPENDENCIES'];
  return order.map((probe) => ({
    probe,
    count: report?.byProbe?.[probe] ?? 0,
  }));
}