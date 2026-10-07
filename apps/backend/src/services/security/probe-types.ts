import type { AiSuggestion } from '../ai/finding-taxonomy';

/**
 * The deterministic security layer — three probes (SAST, secrets,
 * dependencies) plus a risk engine that combines their findings with the
 * model's. Nothing in here asks the LLM "is this secure?": every probe is a
 * pattern, an entropy calculation, or an advisory lookup.
 */

export type SecurityProbe = 'SAST' | 'SECRETS' | 'DEPENDENCIES';

export type SecurityCheckStatus = 'PASS' | 'FAIL' | 'SKIPPED';

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
 * three — SAST / SECRETS / DEPENDENCIES — mirroring rule_checks.
 */
export interface SecurityCheckRecord {
  probe: SecurityProbe;
  ruleKey: string;
  ruleName: string;
  status: SecurityCheckStatus;
  findingCount: number;
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