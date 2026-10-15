import { isTestPath } from './test-discovery.service';
import { CONTEXT_EXCLUDED_SEGMENTS } from '../../utils/constants';

/**
 * Safe, code-free validation for a proposed test file.
 *
 * Everything here is structural: it never parses or executes the drafted code.
 * The goal is to guarantee the two facts a write depends on — that the target
 * path cannot escape the repository or overwrite a non-test file, and that the
 * content is plausible text we are willing to commit — and to be honest about
 * what was and was not checked.
 */

export const MAX_TEST_PATH_LENGTH = 400;

const TEST_SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.go', '.java', '.js', '.jsx', '.kt', '.kts',
  '.mjs', '.mts', '.php', '.py', '.rb', '.rs', '.scala', '.swift', '.ts',
  '.tsx', '.cts', '.cjs',
]);
const TEST_FILE_NAME_PATTERNS = [
  /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/i,
  /_test\.(?:py|go|rb)$/i,
  /^test_.*\.py$/i,
  /_spec\.rb$/i,
  /Test\.(?:java|kt|kts|cs|scala|swift)$/,
];

export interface PathValidation {
  ok: boolean;
  /** The normalized, safe path when `ok` is true. */
  path?: string;
  reason?: string;
}

/**
 * Validates a model-proposed test file path.
 *
 * Rejects anything that is not a repo-relative path to a test file: absolute
 * paths, Windows drive letters, backslashes, `..` traversal, excluded
 * directories (node_modules, dist, ...), control characters, and non-test
 * filenames. A rejection is the caller's cue to surface the reason instead of
 * committing.
 */
export function validateProposedTestPath(rawPath: unknown): PathValidation {
  if (typeof rawPath !== 'string') {
    return { ok: false, reason: 'The proposed test path must be a string.' };
  }

  const path = rawPath.trim();
  if (!path) return { ok: false, reason: 'The proposed test path is empty.' };

  if (rawPath.includes('\\')) {
    return { ok: false, reason: 'The proposed test path must use forward slashes.' };
  }
  if (rawPath.length > MAX_TEST_PATH_LENGTH) {
    return { ok: false, reason: `The proposed test path exceeds ${MAX_TEST_PATH_LENGTH} characters.` };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(rawPath)) {
    return { ok: false, reason: 'The proposed test path contains control characters.' };
  }

  const normalized = rawPath.replace(/\\/g, '/');
  if (normalized.startsWith('/')) {
    return { ok: false, reason: 'The proposed test path must be relative to the repository root.' };
  }
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return { ok: false, reason: 'The proposed test path must not include a drive letter.' };
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..')) {
    return { ok: false, reason: 'The proposed test path must not contain ".." segments.' };
  }
  if (segments.some((segment) => segment === '')) {
    return { ok: false, reason: 'The proposed test path must not contain empty segments.' };
  }
  if (segments.some((segment) => CONTEXT_EXCLUDED_SEGMENTS.has(segment.toLowerCase()))) {
    return { ok: false, reason: 'The proposed test path points into an excluded directory.' };
  }

  const base = segments[segments.length - 1];
  if (segments.some(segment => segment.startsWith('.')) ||
      /^(?:conftest|__init__)\.py$/i.test(base) ||
      /^(?:setup(?:Tests)?|global(?:Setup|Teardown)|(?:jest|vitest|pytest)\.config)(?:\.|$)/i.test(base)) {
    return { ok: false, reason: 'Shared setup files, hidden directories, and execution configuration are not test drafts.' };
  }
  const inTestDirectory = segments
    .slice(0, -1)
    .some((segment) => ['test', 'tests', '__tests__', 'spec', 'specs', '__specs__'].includes(segment.toLowerCase()));
  const extension = base.includes('.') ? `.${base.split('.').pop()!.toLowerCase()}` : '';
  const hasTestName = TEST_FILE_NAME_PATTERNS.some((pattern) => pattern.test(base));
  const isTestSource = hasTestName || (inTestDirectory && TEST_SOURCE_EXTENSIONS.has(extension));

  if (!isTestPath(normalized) || !isTestSource) {
    return {
      ok: false,
      reason: 'The proposed path must be a source-code test file (e.g. foo.test.ts, test_foo.py, or FooTest.java).',
    };
  }

  return { ok: true, path: normalized };
}

export const MAX_TEST_DRAFT_CONTENT_LENGTH = 200_000;

export interface ContentValidation {
  ok: boolean;
  reason?: string;
  /**
   * Best-effort structural note. `delimiters` is a cheap brace/paren/bracket
   * balance check, not a parser, so it is reported rather than enforced.
   */
  note?: string;
}

/**
 * Validates drafted test content before it can be stored or committed.
 *
 * Blocking checks are conservative and cannot execute anything: non-empty,
 * within size limits, and free of NUL bytes (a binary blob committed as a test
 * file). The delimiter balance check is heuristic — strings, comments, regex
 * literals and template expansion can all confuse it — so it only produces a
 * note for the user; it never blocks a write.
 */
export function validateDraftContent(content: unknown): ContentValidation {
  if (typeof content !== 'string') {
    return { ok: false, reason: 'Draft content must be a string.' };
  }
  if (content.trim().length === 0) {
    return { ok: false, reason: 'Draft content is empty.' };
  }
  if (content.length > MAX_TEST_DRAFT_CONTENT_LENGTH) {
    return { ok: false, reason: `Draft content exceeds ${MAX_TEST_DRAFT_CONTENT_LENGTH} characters.` };
  }
  if (content.includes('\0')) {
    return { ok: false, reason: 'Draft content contains a NUL byte and is not text.' };
  }

  const balance = checkDelimiterBalance(content);
  return {
    ok: true,
    note: balance.balanced
      ? undefined
      : `Best-effort check: ${balance.reason}. This is a heuristic, not a parser, and CI has not run.`,
  };
}

export interface DelimiterBalance {
  balanced: boolean;
  reason?: string;
}

/**
 * A deliberately small delimiter-balance heuristic.
 *
 * It strips line/block comments, single/double-quoted strings, and template
 * literals before counting `{}`, `()`, `[]`, which removes the most common
 * false positives. It is still not a parser: regular-expression literals and
 * nested template `${}` are approximated. That is why its verdict is surfaced
 * as a note, never as a hard gate.
 */
export function checkDelimiterBalance(source: string): DelimiterBalance {
  const stripped = stripStringsAndComments(source);
  const pairs: Array<[string, string]> = [
    ['{', '}'],
    ['(', ')'],
    ['[', ']'],
  ];
  const openToClose = new Map(pairs);
  const closeToOpen = new Map(pairs.map(([o, c]) => [c, o]));
  const stack: string[] = [];

  for (const char of stripped) {
    if (openToClose.has(char)) {
      stack.push(char);
    } else if (closeToOpen.has(char)) {
      const expected = closeToOpen.get(char)!;
      if (stack.pop() !== expected) {
        return { balanced: false, reason: `unbalanced ${char}` };
      }
    }
  }

  if (stack.length > 0) {
    return { balanced: false, reason: `unclosed ${stack[stack.length - 1]}` };
  }
  return { balanced: true };
}

function stripStringsAndComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      i++;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    out += char;
    i++;
  }
  return out;
}
