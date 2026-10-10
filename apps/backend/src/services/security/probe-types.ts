import type { AiSuggestion } from '../ai/finding-taxonomy';

/**
 * The deterministic security layer — three probes (SAST, secrets,
 * dependencies) plus a risk engine that combines their findings with the
 * model's. Nothing in here asks the LLM "is this secure?": every probe is a
 * pattern, an entropy calculation, or an advisory lookup.
 */

export type SecurityProbe = 'SAST' | 'SECRETS' | 'DEPENDENCIES';

/**
 * Outcome of one probe for one job.
 *
 * - PASS — the probe ran with full coverage and found nothing.
 * - FAIL — the probe ran and found at least one finding.
 * - SKIPPED — the probe was enabled but had nothing applicable to scan (no
 *   manifests/lockfiles in the diff), or could not run at all.
 * - DEGRADED — the probe ran but with *reduced* coverage: one of its optional
 *   inputs (Semgrep binary, live OSV database) was unavailable, so a clean
 *   result must NOT be read as a full scan. `detail` explains the reduction.
 */
export type SecurityCheckStatus = 'PASS' | 'FAIL' | 'SKIPPED' | 'DEGRADED';

/** A security finding is an `AiSuggestion` that says who produced it. */
export interface SecuritySuggestion extends AiSuggestion {
  source: 'SAST' | 'SECRETS' | 'DEPENDENCIES';
  /** Probe rule that fired (e.g. "sast-sql-template"). Grouped with probe name. */
  ruleKey: string;
  /** True when the finding's issue text hides the secret instead of quoting it. */
  redacted?: boolean;
}

/**
 * One durable outcome row per probe per job. A review normally writes at most
 * three — SAST / SECRETS / DEPENDENCIES — mirroring rule_checks. `detail` holds
 * a human-readable note when the status is DEGRADED (which optional input was
 * unavailable) or SKIPPED (why nothing was scanned).
 */
export interface SecurityCheckRecord {
  probe: SecurityProbe;
  ruleKey: string;
  ruleName: string;
  status: SecurityCheckStatus;
  findingCount: number;
  detail?: string;
}

export interface SecurityProbeResult {
  findings: SecuritySuggestion[];
  checks: SecurityCheckRecord[];
}

/**
 * Ceiling on findings reported per probe rule. A pattern like a URL-credentials
 * regex can match most changed lines; without a cap one bad rule would post
 * hundreds of inline comments on a single PR. Mirrors the rules engine's cap.
 */
export const MAX_FINDINGS_PER_RULE = 50;

/**
 * Deterministic findings always bypass `min_severity` — the security layer
 * must not be quietly optional behind a repo-wide threshold. See the worker
 * for where that decision is applied.
 */
export function checkForProbe(probe: SecurityProbe, ruleKey: string, ruleName: string, findingCount: number): SecurityCheckRecord {
  return {
    probe,
    ruleKey,
    ruleName,
    status: findingCount > 0 ? 'FAIL' : 'PASS',
    findingCount,
  };
}

/**
 * Constructor for the non-happy-path statuses. The shared priority rule keeps
 * the probe summary readable: a probe that found something is FAIL even when
 * it also ran degraded, and a probe that ran fully but clean is PASS.
 */
export function checkForProbeWithStatus(
  probe: SecurityProbe,
  ruleKey: string,
  ruleName: string,
  status: 'SKIPPED' | 'DEGRADED',
  findingCount: number,
  detail?: string,
): SecurityCheckRecord {
  return {
    probe,
    ruleKey,
    ruleName,
    status: findingCount > 0 ? 'FAIL' : status,
    findingCount,
    ...(detail ? { detail } : {}),
  };
}