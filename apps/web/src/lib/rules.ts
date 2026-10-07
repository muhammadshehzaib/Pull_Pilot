/**
 * Engineering-rule vocabulary for the web app.
 *
 * Mirrors `apps/backend/src/services/rules.service.ts` and the Prisma
 * `RepositoryRule` / `RuleCheck` models. Kept beside the review vocabulary in
 * `lib/review.ts`'s spirit: severity and category reuse those canonical
 * unions so a rule's badge always matches a finding's badge.
 */

import type { AgentType, Priority } from './review';

export type RuleEnforcement = 'LLM' | 'DETERMINISTIC' | 'BOTH';

export type RuleCheckStatus = 'PASS' | 'FAIL' | 'SKIPPED';

export interface RepositoryRule {
  id: string;
  repositoryId: string;
  name: string;
  description: string | null;
  guideline: string | null;
  pattern: string | null;
  severity: Priority;
  category: AgentType;
  enforcement: RuleEnforcement;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One rule's outcome on one analysis job. */
export interface RuleCheck {
  id: string;
  ruleId: string | null;
  ruleName: string;
  status: RuleCheckStatus;
  violationCount: number;
  createdAt: string;
}

export const ENFORCEMENT_LABELS: Record<RuleEnforcement, string> = {
  LLM: 'Model',
  DETERMINISTIC: 'Pattern',
  BOTH: 'Model + Pattern',
};

export const ENFORCEMENT_HINTS: Record<RuleEnforcement, string> = {
  LLM: 'Wording handed to the AI reviewer — it reports a finding when it judges a change broke the rule.',
  DETERMINISTIC: 'A regular expression checked against every added line — no model judgement involved.',
  BOTH: 'Checked deterministically AND given to the model for judgement calls.',
};

export const CHECK_STATUS_LABELS: Record<RuleCheckStatus, string> = {
  PASS: 'Passed',
  FAIL: 'Failed',
  SKIPPED: 'Model-enforced',
};

export const CHECK_STATUS_COLORS: Record<RuleCheckStatus, string> = {
  PASS: 'var(--success)',
  FAIL: 'var(--danger)',
  SKIPPED: 'var(--text-secondary)',
};

/** Human summary, e.g. "2 passed, 1 failed, 1 model-enforced". */
export function summarizeChecks(checks: RuleCheck[]): string {
  const count = (status: RuleCheckStatus) => checks.filter((c) => c.status === status).length;
  const parts: string[] = [];
  if (count('PASS')) parts.push(`${count('PASS')} passed`);
  if (count('FAIL')) parts.push(`${count('FAIL')} failed`);
  if (count('SKIPPED')) parts.push(`${count('SKIPPED')} model-enforced`);
  return parts.join(', ');
}
