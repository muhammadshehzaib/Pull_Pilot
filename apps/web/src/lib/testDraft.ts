import type { TestGapScenario } from './testGap';

/**
 * Test-draft vocabulary for the web app.
 *
 * Mirrors the backend shape. A draft is AI-generated and unverified until a CI
 * run says otherwise, so every presentation of it carries that caveat.
 */

export type TestDraftStatus = 'DRAFT' | 'PR_CREATED' | 'DISCARDED';

export interface TestDraft {
  id: string;
  repositoryId: string;
  analysisJobId: string | null;
  scenario: TestGapScenario;
  sourcePath: string;
  targetPath: string;
  targetContent: string;
  framework: string | null;
  notes: string | null;
  structuralNote: string | null;
  baseBranch: string;
  baseSha: string;
  sourcePrNumber: number | null;
  status: TestDraftStatus;
  branchName: string | null;
  commitSha: string | null;
  prNumber: number | null;
  prUrl: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Shown wherever a draft is displayed or a PR is described. */
export const AI_DRAFT_DISCLAIMER =
  'AI-generated and not executed by this service. Download and review the code, then test it in an isolated environment without secrets. Automatic PR creation is disabled to protect your CI credentials.';

const TEST_DIR_SEGMENTS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', '__specs__']);
const EXCLUDED_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  'target',
]);
const TEST_FILE_PATTERNS: RegExp[] = [
  /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/i,
  /_test\.(?:py|go|rb)$/i,
  /^test_.*\.py$/i,
  /_spec\.rb$/i,
  /Test\.(?:java|kt|kts|cs|scala|swift)$/,
];
const TEST_SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.go', '.java', '.js', '.jsx', '.kt', '.kts',
  '.mjs', '.mts', '.php', '.py', '.rb', '.rs', '.scala', '.swift', '.ts',
  '.tsx', '.cts', '.cjs',
]);

export interface PathCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Client-side mirror of the backend path guard, so unsafe paths are blocked
 * before a request is even sent. The backend re-validates — this is UX, not the
 * security boundary.
 */
export function validateProposedTestPath(rawPath: string): PathCheck {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    return { ok: false, reason: 'A test file path is required.' };
  }
  const path = rawPath.trim();
  if (path.includes('\\')) return { ok: false, reason: 'Use forward slashes in the path.' };
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
    return { ok: false, reason: 'The path must be relative to the repository root.' };
  }
  if (path.length > 400) return { ok: false, reason: 'The path is too long.' };

  const segments = path.split('/');
  if (segments.some((segment) => segment === '..')) {
    return { ok: false, reason: 'The path must not contain ".." segments.' };
  }
  if (segments.some((segment) => segment === '')) {
    return { ok: false, reason: 'The path must not contain empty segments.' };
  }
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment.toLowerCase()))) {
    return { ok: false, reason: 'The path points into an excluded directory.' };
  }

  const base = path.split('/').pop() ?? '';
  if (segments.some(segment => segment.startsWith('.')) ||
      /^(?:conftest|__init__)\.py$/i.test(base) ||
      /^(?:setup(?:Tests)?|global(?:Setup|Teardown)|(?:jest|vitest|pytest)\.config)(?:\.|$)/i.test(base)) {
    return { ok: false, reason: 'Shared setup files, hidden directories, and execution configuration are not test drafts.' };
  }
  const inTestDir = path
    .split('/')
    .slice(0, -1)
    .some((segment) => TEST_DIR_SEGMENTS.has(segment.toLowerCase()));
  const extension = base.includes('.') ? `.${base.split('.').pop()!.toLowerCase()}` : '';
  const hasTestName = TEST_FILE_PATTERNS.some((re) => re.test(base));
  if (!hasTestName && !(inTestDir && TEST_SOURCE_EXTENSIONS.has(extension))) {
    return { ok: false, reason: 'This does not look like a test file path.' };
  }
  return { ok: true };
}

/** A draft can only be edited while it is still pending. */
export function isDraftEditable(draft: TestDraft | null): boolean {
  return Boolean(draft && draft.status === 'DRAFT');
}

/**
 * Legacy UI gate. Confirmation does not establish safe CI execution.
 */
export function canCreateTestPr(_draft: TestDraft | null, _confirmed: boolean): boolean {
  return false;
}

export const DRAFT_STATUS_LABELS: Record<TestDraftStatus, string> = {
  DRAFT: 'Pending review',
  PR_CREATED: 'PR created',
  DISCARDED: 'Discarded',
};

export function draftStatusLabel(status: TestDraftStatus): string {
  return DRAFT_STATUS_LABELS[status] ?? status;
}
