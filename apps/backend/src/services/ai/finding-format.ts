import { AiSuggestion, FindingCategory, FindingSeverity, SEVERITY_RANK, normalizeSeverity } from './finding-taxonomy';

/**
 * Presentation layer for findings.
 *
 * Severity is the thing a developer scans first, so it gets a colour glyph
 * rather than a bracketed word. These maps are the single place the glyphs are
 * defined; the summary table and the inline comments must agree, otherwise the
 * same finding looks like two different severities depending on where you read
 * it.
 */
const SEVERITY_GLYPH: Record<FindingSeverity, string> = {
  CRITICAL: '🔴',
  HIGH: '🟠',
  MEDIUM: '🟡',
  LOW: '🔵',
  INFO: '⚪',
};

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
  INFO: 'Info',
};

/** Severity order, most severe first, for rendering count tables. */
const SEVERITY_ORDER: FindingSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

export function severityOf(finding: { priority: string }): FindingSeverity {
  return normalizeSeverity(finding.priority) ?? 'INFO';
}

/** e.g. "🔴 Critical" */
export function severityBadge(severity: string | undefined): string {
  const resolved = normalizeSeverity(severity) ?? 'INFO';
  return `${SEVERITY_GLYPH[resolved]} ${SEVERITY_LABEL[resolved]}`;
}

/** Counts per severity, with zero-count levels included so the table is stable. */
export function countBySeverity(findings: { priority: string }[]): Record<FindingSeverity, number> {
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 } as Record<FindingSeverity, number>;
  for (const finding of findings) {
    counts[severityOf(finding)] += 1;
  }
  return counts;
}

/** "🔴 2 · 🟠 3 · 🟡 4" — omits levels with no findings. */
export function severityTally(findings: { priority: string }[]): string {
  const counts = countBySeverity(findings);
  return SEVERITY_ORDER.filter((level) => counts[level] > 0)
    .map((level) => `${SEVERITY_GLYPH[level]} ${counts[level]}`)
    .join(' · ');
}

/**
 * The body of one inline review comment.
 *
 * Severity leads, then the category, then the defect and the fix. The issue and
 * suggestion are untrusted text. Advice is read-only: this field does not prove
 * an exact replacement for the selected source range.
 */
export function renderInlineComment(finding: AiSuggestion): string {
  const badge = severityBadge(finding.priority);
  const category = String(finding.agentType).replace(/_/g, ' ').toLowerCase();

  return [
    `### ${badge} ${escapeText(finding.agentType)}`,
    '',
    `**${escapeText(capitalize(category))}:** ${escapeText(finding.issue)}`,
    '',
    '**Suggested approach (manual review):**',
    '',
    readOnlyBlock(finding.suggestion),
  ].join('\n');
}

/** One line per finding for the consolidated fallback comment. */
export function renderFindingListItem(finding: AiSuggestion, index: number): string {
  const badge = severityBadge(finding.priority);
  return [
    `${index + 1}. **${badge}** ${inlineCode(`${finding.filePath}:${finding.lineNumber}`)}`,
    `   - **${escapeText(finding.agentType)}:** ${escapeText(finding.issue)}`,
    `   - **Fix (manual review):** ${escapeText(firstLine(finding.suggestion))}`,
  ].join('\n');
}

function firstLine(text: string): string {
  const line = text.replace(/\r\n?/g, '\n').split('\n').find((candidate) => candidate.trim().length > 0) ?? text;
  return line.length > 220 ? `${line.slice(0, 217)}...` : line;
}

/** Plain prose cannot introduce headings, links, HTML, or additional fences. */
function escapeText(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/[!-/:-@\[-`{-~]/g, character => {
    if (character === '&') return '&amp;';
    if (character === '<') return '&lt;';
    if (character === '>') return '&gt;';
    if (character === '@') return '&#64;';
    return `\\${character}`;
  });
}

function longestBacktickRun(text: string): number {
  let longest = 0, run = 0;
  for (const character of text) {
    run = character === '`' ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

function readOnlyBlock(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n');
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(normalized) + 1));
  return `${fence}text\n${normalized}\n${fence}`;
}

function inlineCode(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const delimiter = '`'.repeat(longestBacktickRun(normalized) + 1);
  const padding = normalized.includes('`') ? ' ' : '';
  return `${delimiter}${padding}${normalized}${padding}${delimiter}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Convenience for callers holding loosely-typed findings from the DB JSON. */
export function isBlockingSeverity(finding: { priority: string }): boolean {
  return (SEVERITY_RANK[severityOf(finding)] ?? 0) >= SEVERITY_RANK.HIGH;
}

export type { FindingCategory };
