import { AiSuggestion, FindingCategory, SEVERITY_RANK, normalizeSeverity } from './finding-taxonomy';

/**
 * Collapses the repeated findings models produce for a single defect.
 *
 * A model asked for "one finding per distinct problem" still emits the same
 * problem several times: once per line of a multi-line block, once per call
 * site, and with inconsistent severity ("HIGH" for one instance, "MEDIUM" for
 * the next). Posting all of them produces the 20-comment review this product is
 * trying not to be, so findings are merged before they reach GitHub.
 */

/** How close two findings must be to be treated as the same location. */
const NEARBY_LINE_WINDOW = 3;

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

/**
 * Strips the parts of an issue description that vary between two phrasings of
 * the same problem: code identifiers get folded to a placeholder, punctuation
 * and stopwords are dropped. Returns a sorted token set, so "Unchecked
 * `user.id` may be null" and "user.id is not checked, may be null" both reduce
 * to a comparable bag of words.
 */
export function fingerprint(issue: string): string {
  return tokenize(issue).sort().join(' ');
}

/** Content words only, in document order, as a Set for overlap scoring. */
function tokenize(issue: string): string[] {
  return issue
    .toLowerCase()
    .replace(/`[^`]*`/g, ' ')
    .replace(/\b[a-z]+(?:[A-Z][a-z0-9]*)+(?:\.[a-zA-Z_$][\w$]*)*\b/g, ' ')
    .replace(/\b[a-z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)+\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'into', 'when', 'will',
  'may', 'can', 'not', 'but', 'you', 'your', 'its', 'are', 'was', 'were',
  'has', 'have', 'had', 'been', 'also', 'any', 'all', 'should', 'could',
  'would', 'there', 'their', 'them', 'they', 'than', 'then', 'does', 'did',
  'being', 'some', 'such', 'only', 'over', 'same', 'each', 'more', 'most',
  'other', 'which', 'while', 'about', 'after', 'before', 'because', 'both',
  'during', 'however', 'instead', 'unless', 'until', 'what', 'where', 'whom',
  'whose',
]);

/**
 * Token overlap (Jaccard) between two issue descriptions.
 *
 * Jaccard rather than substring containment because paraphrases reorder and
 * add words: "user.id is not validated" vs "validates user.id" share tokens
 * without either containing the other. 0.6 keeps paraphrases together while
 * leaving distinct problems on one line alone.
 */
function similarity(a: string, b: string): number {
  const tokensA = new Set(tokenize(a));
  const tokensB = new Set(tokenize(b));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let shared = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) shared += 1;
  }

  return shared / (tokensA.size + tokensB.size - shared);
}

/** Minimum overlap for two reports to be considered one problem. */
const SIMILARITY_THRESHOLD = 0.6;

/** Highest severity wins so merging never hides a CRITICAL behind a MEDIUM. */
function strongestSeverity(a: string, b: string): AiSuggestion['priority'] {
  return (SEVERITY_RANK[normalizeSeverity(a) ?? 'INFO'] ?? 0) >=
    (SEVERITY_RANK[normalizeSeverity(b) ?? 'INFO'] ?? 0)
    ? (a as AiSuggestion['priority'])
    : (b as AiSuggestion['priority']);
}

/**
 * Exact-duplicate key. Cheap and conservative: only folds findings that agree
 * on file, category and location, so two real issues on one line survive.
 */
function exactKey(finding: AiSuggestion): string {
  return [
    normalizePath(finding.filePath),
    finding.agentType,
    finding.lineNumber,
    fingerprint(finding.issue),
  ].join('|');
}

/** Broader key used to catch the same issue re-reported slightly differently. */
function looseKey(finding: AiSuggestion): string {
  return [normalizePath(finding.filePath), finding.agentType, fingerprint(finding.issue)].join('|');
}

/**
 * Merges duplicates in place-safe fashion and returns the survivors in their
 * original order, so callers can keep sorting by severity afterwards.
 *
 * @param findings raw model output, already severity-filtered
 */
export function deduplicate(findings: AiSuggestion[]): AiSuggestion[] {
  if (findings.length < 2) return findings.slice();

  const kept: AiSuggestion[] = [];
  // Fingerprint -> index into `kept`, so a repeat is found without re-scanning.
  const byLooseKey = new Map<string, number>();

  for (const finding of findings) {
    const exact = exactKey(finding);
    const loose = looseKey(finding);

    const exactHit = kept.findIndex((k) => exactKey(k) === exact);
    if (exactHit !== -1) {
      kept[exactHit] = merge(kept[exactHit], finding);
      continue;
    }

    const looseHit = byLooseKey.get(loose);
    if (looseHit !== undefined) {
      kept[looseHit] = merge(kept[looseHit], finding);
      continue;
    }

    // Not an exact repeat, but the same file + category within a few lines is
    // the model reporting one problem across a multi-line block.
    const nearby = kept.findIndex((k) => {
      if (normalizePath(k.filePath) !== normalizePath(finding.filePath)) return false;
      if (k.agentType !== finding.agentType) return false;
      return Math.abs((k.lineNumber || 0) - (finding.lineNumber || 0)) <= NEARBY_LINE_WINDOW;
    });
    if (nearby !== -1 && similarity(kept[nearby].issue, finding.issue) >= SIMILARITY_THRESHOLD) {
      kept[nearby] = merge(kept[nearby], finding);
      continue;
    }

    byLooseKey.set(loose, kept.length);
    kept.push({ ...finding });
  }

  return kept;
}

/**
 * Provenance order used when two engines report the same defect and we have to
 * pick whose `source` label survives. Deterministic engines are more truthful
 * about what they saw than a model paraphrase, so SEALED sources (a secret is a
 * fact, not a guess) rank above pattern matches, which rank above the model.
 */
const SOURCE_RANK = { SECRETS: 5, DEPENDENCIES: 4, SAST: 3, RULES: 2, LLM: 1 } as const;

function strongerSource(a?: string, b?: string): AiSuggestion['source'] {
  const rankA = a ? (SOURCE_RANK[a as keyof typeof SOURCE_RANK] ?? 0) : 0;
  const rankB = b ? (SOURCE_RANK[b as keyof typeof SOURCE_RANK] ?? 0) : 0;
  if (rankA >= rankB && a) return a as AiSuggestion['source'];
  if (rankB > rankA && b) return b as AiSuggestion['source'];
  return undefined;
}

/**
 * Combines two reports of one problem. Keeps the earliest cited line (the line
 * the developer will jump to), the strongest severity, the longer
 * suggestion text, and the stronger provenance (see strongerSource).
 */
function merge(existing: AiSuggestion, incoming: AiSuggestion): AiSuggestion {
  const line =
    existing.lineNumber > 0 && incoming.lineNumber > 0
      ? Math.min(existing.lineNumber, incoming.lineNumber)
      : existing.lineNumber || incoming.lineNumber;

  return {
    filePath: existing.filePath,
    lineNumber: line,
    agentType: existing.agentType as FindingCategory,
    issue: existing.issue.length >= incoming.issue.length ? existing.issue : incoming.issue,
    suggestion: existing.suggestion.length >= incoming.suggestion.length ? existing.suggestion : incoming.suggestion,
    priority: strongestSeverity(existing.priority, incoming.priority),
    // A deterministic report of the same defect stays deterministically sourced
    // even if the model mentioned it first.
    source: strongerSource(existing.source, incoming.source),
  };
}
