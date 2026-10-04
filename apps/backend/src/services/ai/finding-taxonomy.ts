/**
 * Single source of truth for finding severity and category.
 *
 * Previously the severity vocabulary lived in four divergent places (the
 * provider prompt, two `AiSuggestion` interfaces, the worker's sort map, the
 * frontend label maps) and two of them disagreed. Everything now derives from
 * this module so a new level or category only has to be added once.
 */

/** Severity levels, ordered most to least severe. */
export const FINDING_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** Review categories. */
export const FINDING_CATEGORIES = [
  'SECURITY',
  'BUG',
  'CORRECTNESS',
  'PERFORMANCE',
  'ARCHITECTURE',
  'MAINTAINABILITY',
  'STYLE',
  'TESTING',
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export interface AiSuggestion {
  filePath: string;
  lineNumber: number;
  agentType: FindingCategory;
  issue: string;
  suggestion: string;
  priority: FindingSeverity;
}

/**
 * Higher number = more severe. Used for both threshold filtering and sorting.
 */
export const SEVERITY_RANK: Record<FindingSeverity, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  INFO: 0,
};

const SEVERITY_ALIASES: Record<string, FindingSeverity> = {
  CRITICAL: 'CRITICAL',
  BLOCKER: 'CRITICAL',
  FATAL: 'CRITICAL',
  SEVERE: 'CRITICAL',
  HIGH: 'HIGH',
  MAJOR: 'HIGH',
  ERROR: 'HIGH',
  MEDIUM: 'MEDIUM',
  MODERATE: 'MEDIUM',
  NORMAL: 'MEDIUM',
  WARNING: 'MEDIUM',
  LOW: 'LOW',
  MINOR: 'LOW',
  INFO: 'INFO',
  INFORMATIONAL: 'INFO',
  NOTICE: 'INFO',
  TRIVIAL: 'INFO',
  NIT: 'INFO',
};

const CATEGORY_ALIASES: Record<string, FindingCategory> = {
  SECURITY: 'SECURITY',
  VULNERABILITY: 'SECURITY',
  VULN: 'SECURITY',
  BUG: 'BUG',
  BUG_RISK: 'BUG',
  DEFECT: 'BUG',
  REGRESSION: 'BUG',
  CORRECTNESS: 'CORRECTNESS',
  LOGIC: 'CORRECTNESS',
  VALIDATION: 'CORRECTNESS',
  TYPE_SAFETY: 'CORRECTNESS',
  PERFORMANCE: 'PERFORMANCE',
  OPTIMIZATION: 'PERFORMANCE',
  MEMORY: 'PERFORMANCE',
  ARCHITECTURE: 'ARCHITECTURE',
  DESIGN: 'ARCHITECTURE',
  MAINTAINABILITY: 'MAINTAINABILITY',
  MAINTAINABILITY_RISK: 'MAINTAINABILITY',
  CLEANUP: 'MAINTAINABILITY',
  READABILITY: 'MAINTAINABILITY',
  NAMING: 'MAINTAINABILITY',
  DUPLICATION: 'MAINTAINABILITY',
  STYLE: 'STYLE',
  FORMATTING: 'STYLE',
  TESTING: 'TESTING',
  TEST: 'TESTING',
  TESTS: 'TESTING',
  TEST_COVERAGE: 'TESTING',
};

/**
 * Models are inconsistent about casing and wording, so map anything
 * recognisable onto the canonical vocabulary. Returns null when the value is
 * unusable so callers can decide whether to drop or default the finding.
 */
export function normalizeSeverity(value: unknown): FindingSeverity | null {
  if (typeof value !== 'string') return null;
  return SEVERITY_ALIASES[value.trim().toUpperCase()] ?? null;
}

export function normalizeCategory(value: unknown): FindingCategory | null {
  if (typeof value !== 'string') return null;
  return CATEGORY_ALIASES[value.trim().toUpperCase().replace(/[\s-]+/g, '_')] ?? null;
}

/** Sorts most severe first. Never mutates the input. */
export function sortBySeverity<T extends { priority: string }>(findings: T[]): T[] {
  return findings
    .slice()
    .sort(
      (a, b) =>
        (SEVERITY_RANK[normalizeSeverity(b.priority) ?? 'INFO'] ?? 0) -
        (SEVERITY_RANK[normalizeSeverity(a.priority) ?? 'INFO'] ?? 0),
    );
}

/**
 * Drops anything that is not a usable finding and coerces severity/category
 * onto the canonical vocabulary.
 *
 * Every provider runs its parsed JSON through this. Without it an unknown
 * `priority` string ranks as 0 and silently disappears behind any raised
 * `min_severity`, which is exactly the bug that made `min_severity: critical`
 * return nothing.
 */
export function normalizeSuggestions(raw: unknown): AiSuggestion[] {
  if (!Array.isArray(raw)) return [];

  const out: AiSuggestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;

    const filePath = typeof s.filePath === 'string' ? s.filePath.trim() : '';
    const issue = typeof s.issue === 'string' ? s.issue.trim() : '';
    const suggestion = typeof s.suggestion === 'string' ? s.suggestion.trim() : '';
    // Without these the finding cannot be rendered or acted on.
    if (!filePath || !issue || !suggestion) continue;

    const lineNumber = Number.isFinite(s.lineNumber) ? Math.trunc(Number(s.lineNumber)) : 0;

    // An unrecognised severity is treated as INFO rather than dropped: the
    // reviewer still sees the finding, and INFO is below the default
    // threshold so it will not clutter reviews unless asked for.
    out.push({
      filePath,
      lineNumber,
      issue,
      suggestion,
      agentType: normalizeCategory(s.agentType) ?? 'MAINTAINABILITY',
      priority: normalizeSeverity(s.priority) ?? 'INFO',
    });
  }
  return out;
}