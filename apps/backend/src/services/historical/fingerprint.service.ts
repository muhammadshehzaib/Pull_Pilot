/**
 * Fingerprint service — Phase 8 Historical Intelligence
 *
 * Produces stable, versioned, cross-review grouping keys ("fingerprints")
 * that group semantically equivalent findings across distinct pull requests.
 *
 * Design invariants:
 *  - Fingerprints are versioned (fp_v2_...) so a schema change yields a new
 *    algorithm version instead of silently mixing incompatible groupings.
 *  - Rule/probe findings are fingerprinted by source + ruleKey + path scope,
 *    making them stable across paraphrases.
 *  - LLM findings use category + module scope + a token-level content hash,
 *    tolerating word-order variation while grouping the same problem.
 *  - Path scope is normalised to module level so minor path diffs (e.g.
 *    src/foo.ts vs src/foo.test.ts) still group.
 *  - Repository path casing is preserved; hashes use lower-case hex.
 */

import { createHash } from 'node:crypto';
import type { AiSuggestion, FindingSource } from '../ai/finding-taxonomy';

/** Algorithm version prefix embedded in every fingerprint. */
export const FINGERPRINT_VERSION = 'fp_v2' as const;

/** Sources that are deterministic and have stable rule keys. */
const DETERMINISTIC_SOURCES = new Set<FindingSource>(['SAST', 'SECRETS', 'DEPENDENCIES', 'RULES']);

/**
 * Normalise a file path to its module scope:
 *  - Convert backslashes to forward slashes
 *  - Strip leading ./ or /
 *  - Strip extension
 *  - Drop trailing test/spec suffixes so src/auth.ts and src/auth.test.ts
 *    share the same scope
 */
export function normalizePathScope(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\//, '')
    .replace(/\.(test|spec)\.[jt]sx?$/i, '')
    .replace(/\.[jt]sx?$/i, '')
    .replace(/\.py$/, '')
    .replace(/\.go$/, '')
    .replace(/\.java$/, '')
    .replace(/\.cs$/, '');
}


/** Content hash for LLM findings — paraphrase-resistant. */
function tokenFingerprint(text: string): string {
  const STOP_WORDS = new Set([
    'the', 'and', 'for', 'that', 'this', 'with', 'from', 'into', 'when',
    'will', 'may', 'can', 'not', 'but', 'you', 'your', 'its', 'are', 'was',
    'were', 'has', 'have', 'had', 'been', 'also', 'any', 'all', 'should',
    'could', 'would', 'there', 'their', 'them', 'they', 'than', 'then',
    'does', 'did', 'being', 'some', 'such', 'only', 'over', 'same', 'each',
    'more', 'most', 'other', 'which', 'while', 'about', 'after', 'before',
    'because', 'both', 'during', 'however', 'instead', 'unless', 'until',
    'what', 'where', 'whom', 'whose',
  ]);
  const tokens = text
    .toLowerCase()
    .replace(/`[^`]*`/g, ' ')
    .replace(/\b[a-z]+(?:[A-Z][a-z0-9]*)+(?:\.[a-zA-Z_$][\w$]*)*\b/g, ' ')
    .replace(/\b[a-z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)+\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  const sorted = [...new Set(tokens)].sort().join(' ');
  return createHash('sha256').update(sorted).digest('hex').slice(0, 16);
}

/**
 * Generate a versioned pattern fingerprint for a finding.
 *
 * Deterministic sources: fp_v2_<SOURCE>:<ruleKey|category>:<pathScope>
 * LLM sources:           fp_v2_<CATEGORY>:<pathScope>:<tokenHash>
 */
export function generateFingerprint(finding: AiSuggestion): string {
  const pathScope = normalizePathScope(finding.filePath);
  const source = (finding.source ?? 'LLM') as FindingSource;
  if (DETERMINISTIC_SOURCES.has(source)) {
    const ruleKey = (finding.ruleKeys?.[0] ?? finding.agentType).toLowerCase();
    return `${FINGERPRINT_VERSION}_${source}:${ruleKey}:${pathScope}`;
  }
  const hash = tokenFingerprint(finding.issue);
  return `${FINGERPRINT_VERSION}_${finding.agentType}:${pathScope}:${hash}`;
}

/** Build a bounded (<=maxChars) occurrence summary for the DB column. */
export function buildFindingSummary(finding: AiSuggestion, maxChars = 500): string {
  const parts = `[${finding.priority}/${finding.agentType}] ${finding.issue} (${finding.filePath}:${finding.lineNumber})`;
  return parts.length <= maxChars ? parts : parts.slice(0, maxChars - 1) + '\u2026';
}

/** Build a shorter (<=maxChars) pattern summary for prompt injection. */
export function buildPatternSummary(occurrenceSummary: string, maxChars = 300): string {
  return occurrenceSummary.length <= maxChars
    ? occurrenceSummary
    : occurrenceSummary.slice(0, maxChars - 1) + '\u2026';
}
