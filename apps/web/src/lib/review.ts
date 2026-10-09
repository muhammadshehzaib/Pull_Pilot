/**
 * Shared review vocabulary for the web app.
 *
 * These mirror `apps/backend/src/workers/job-state.ts` and
 * `apps/backend/src/services/ai/finding-taxonomy.ts`. They live in one module
 * rather than beside each component because they drifted before: the backend
 * grew four review phases and the history page kept checking for `RUNNING`,
 * which silently stopped auto-refresh for every in-flight review.
 */

export type EventType = 'PULL_REQUEST' | 'PUSH';

/** Mirrors the Prisma `JobStatus` enum. */
export type JobStatus =
  | 'QUEUED'
  | 'FETCHING'
  | 'ANALYZING'
  | 'GENERATING'
  | 'POSTING'
  | 'RETRYING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'SKIPPED'
  | 'CANCELLED'
  | 'TIMEOUT';

/** Mirrors the backend `FINDING_SEVERITIES`. */
export type Priority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

/** Mirrors the backend `FINDING_CATEGORIES`. */
export type AgentType =
  | 'SECURITY'
  | 'BUG'
  | 'CORRECTNESS'
  | 'PERFORMANCE'
  | 'ARCHITECTURE'
  | 'MAINTAINABILITY'
  | 'STYLE'
  | 'TESTING';

/**
 * Which engine produced a finding. Mirrors the backend `FindingSource`:
 * the model, the repository-rule engine, or one of the deterministic security
 * probes. `corroborated` is true when the risk engine found a deterministic
 * probe in the same file within its corroboration window.
 */
export type FindingSource = 'LLM' | 'RULES' | 'SAST' | 'SECRETS' | 'DEPENDENCIES';

export interface AiSuggestion {
  filePath: string;
  lineNumber: number;
  agentType: AgentType;
  issue: string;
  suggestion: string;
  priority: Priority;
  source?: FindingSource;
  corroborated?: boolean;
}

/**
 * Delivery problems recorded by the worker. A finding listed here was found but
 * GitHub refused the inline comment (usually the cited line is not in the diff),
 * so it only appears in the PR summary — not as an inline comment.
 */
export interface CommentFailure {
  location: string;
  error: string;
}

/**
 * Statuses that mean work is still happening. Polling keys off this rather than
 * a hardcoded pair, so adding a phase on the backend cannot leave the UI
 * refreshing a stale review forever.
 */
export const IN_PROGRESS_STATUSES: readonly JobStatus[] = [
  'QUEUED',
  'FETCHING',
  'ANALYZING',
  'GENERATING',
  'POSTING',
  'RETRYING',
  'RUNNING',
];

/**
 * These take `string` rather than `JobStatus` on purpose: the dashboard receives
 * `status` straight off the socket and the history page receives it from JSON,
 * both of which can carry a value this build has never heard of. Narrowing at
 * the boundary would only move the crash.
 */
export function isInProgress(status: string): boolean {
  return (IN_PROGRESS_STATUSES as readonly string[]).includes(status);
}

/** Statuses that ended without producing findings. */
export const TERMINAL_UNSUCCESSFUL_STATUSES: readonly JobStatus[] = [
  'FAILED',
  'CANCELLED',
  'TIMEOUT',
];

export function isTerminalFailure(status: string): boolean {
  return (TERMINAL_UNSUCCESSFUL_STATUSES as readonly string[]).includes(status);
}

/**
 * `Record<JobStatus, string>` on purpose: adding a status to the union without
 * labelling it is a compile error, not a blank spot in the UI.
 */
export const STATUS_LABELS: Record<JobStatus, string> = {
  QUEUED: 'Queued',
  FETCHING: 'Fetching diff',
  ANALYZING: 'Analyzing',
  GENERATING: 'Building review',
  POSTING: 'Posting comments',
  RETRYING: 'Retrying',
  RUNNING: 'Running',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  SKIPPED: 'Skipped',
  CANCELLED: 'Cancelled',
  TIMEOUT: 'Timed out',
};

export const STATUS_COLORS: Record<JobStatus, string> = {
  QUEUED: 'var(--text-secondary)',
  FETCHING: 'var(--accent)',
  ANALYZING: 'var(--accent)',
  GENERATING: 'var(--accent)',
  POSTING: 'var(--accent)',
  RETRYING: 'var(--warning)',
  RUNNING: 'var(--accent)',
  COMPLETED: 'var(--success)',
  FAILED: 'var(--danger)',
  SKIPPED: 'var(--text-muted)',
  CANCELLED: 'var(--text-muted)',
  TIMEOUT: 'var(--warning)',
};

/**
 * The label for an arbitrary string from the API. A status this build has never
 * seen still renders something readable instead of `undefined`.
 */
export function statusLabel(status: string): string {
  return STATUS_LABELS[status as JobStatus] ?? humanize(status);
}

function humanize(status: string): string {
  return status
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export const PRIORITY_LABELS: Record<Priority, string> = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
  INFO: 'Info',
};

export const PRIORITY_COLORS: Record<Priority, string> = {
  CRITICAL: '#a21caf',
  HIGH: 'var(--danger)',
  MEDIUM: 'var(--warning)',
  LOW: 'var(--accent)',
  INFO: 'var(--text-secondary)',
};

/**
 * Severity glyphs.
 *
 * These must match `apps/backend/src/services/ai/finding-format.ts` exactly.
 * They previously did not — the dashboard used 🔥🚨⚠️🔎ℹ️ while GitHub comments
 * used 🔴🟠🟡🔵⚪ — so the same finding wore a different badge depending on where
 * you read it, and the colour language the product promises in review comments
 * was absent from the dashboard.
 */
export const PRIORITY_ICONS: Record<Priority, string> = {
  CRITICAL: '🔴',
  HIGH: '🟠',
  MEDIUM: '🟡',
  LOW: '🔵',
  INFO: '⚪',
};

/** Most severe first. Mirrors the backend `SEVERITY_RANK`. */
export const PRIORITY_ORDER: Record<Priority, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4,
};

export const AGENT_LABELS: Record<AgentType, string> = {
  SECURITY: 'Security',
  BUG: 'Bug',
  CORRECTNESS: 'Correctness',
  PERFORMANCE: 'Performance',
  ARCHITECTURE: 'Architecture',
  MAINTAINABILITY: 'Maintainability',
  STYLE: 'Style',
  TESTING: 'Testing',
};

export const SOURCE_LABELS: Record<FindingSource, string> = {
  LLM: 'Model',
  RULES: 'Rule',
  SAST: 'SAST',
  SECRETS: 'Secrets',
  DEPENDENCIES: 'Deps',
};

/**
 * Badge colour per provenance. Secrets findings are the only ones that are
 * red without double-checking: a hardcoded credential is a fact, not a model
 * judgement call.
 */
export const SOURCE_COLORS: Record<FindingSource, string> = {
  LLM: 'var(--text-secondary)',
  RULES: 'var(--accent)',
  SAST: 'var(--accent)',
  SECRETS: '#dc2626',
  DEPENDENCIES: '#d97706',
};

/**
 * Short badge label for a finding's provenance. Takes `string` because the API
 * can carry a source this build has never heard of; an unknown source gets the
 * model label rather than a crash.
 */
export function sourceLabel(source: string | undefined): string {
  if (!source) return SOURCE_LABELS.LLM;
  return SOURCE_LABELS[source as FindingSource] ?? SOURCE_LABELS.LLM;
}

export function sourceColor(source: string | undefined): string {
  return SOURCE_COLORS[source as FindingSource] ?? SOURCE_COLORS.LLM;
}

/**
 * Severities that should block a merge. Mirrors the backend `min_severity`
 * semantics so the dashboard highlights the same findings the reviewer treats
 * as release blockers.
 */
const BLOCKING: readonly Priority[] = ['CRITICAL', 'HIGH'];

export function isBlocking(priority: Priority): boolean {
  return BLOCKING.includes(priority);
}

export interface SeverityTally {
  level: Priority;
  label: string;
  icon: string;
  color: string;
  count: number;
}

/** Per-severity counts, most severe first, omitting empty levels. */
export function tallyBySeverity(findings: { priority: Priority }[]): SeverityTally[] {
  const order = Object.keys(PRIORITY_ORDER) as Priority[];
  return order
    .map((level) => ({
      level,
      label: PRIORITY_LABELS[level],
      icon: PRIORITY_ICONS[level],
      color: PRIORITY_COLORS[level],
      count: findings.filter((finding) => finding.priority === level).length,
    }))
    .filter((entry) => entry.count > 0);
}
