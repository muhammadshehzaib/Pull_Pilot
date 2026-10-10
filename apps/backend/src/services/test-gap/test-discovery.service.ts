import { GitHubService } from '../github.service';
import { CONTEXT_EXCLUDED_SEGMENTS, CONTEXT_SOURCE_EXTENSIONS } from '../../utils/constants';
import type { TestGapInput } from './test-gap-types';

/**
 * Deterministic test discovery.
 *
 * Before the model proposes missing tests, discovery answers two factual
 * questions: which changed files are code under test, and which existing tests
 * line up with them under the usual naming conventions. It is pure path work —
 * no model, no execution — so the result is reproducible and cheap.
 *
 * Everything is bounded. A model fed a whole test suite would spend its budget
 * reading tests instead of reasoning about the change, so the inventory and the
 * excerpts are all capped.
 */

export const MAX_TEST_SOURCES = 12;
export const MAX_RELATED_TESTS = 8;
export const MAX_TEST_EXCERPT_CHARS = 6000;

const TEST_DIR_SEGMENTS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', '__specs__']);

const TEST_FILE_PATTERNS: RegExp[] = [
  /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/i, // foo.test.ts, foo.spec.tsx
  /_test\.(?:py|go|rb)$/i, //               foo_test.py, foo_test.go
  /^test_.*\.py$/i, //                      test_foo.py
  /_spec\.rb$/i, //                         foo_spec.rb
  /Test\.(?:java|kt|kts|cs|scala|swift)$/, // FooTest.java
];

function normalize(path: string): string {
  return path.replace(/\\/g, '/');
}

/** True for a repo path that looks like a test file. */
export function isTestPath(path: string): boolean {
  const normalized = normalize(path);
  const segments = normalized.split('/');
  const base = segments[segments.length - 1];

  if (segments.slice(0, -1).some((segment) => TEST_DIR_SEGMENTS.has(segment.toLowerCase()))) {
    return true;
  }
  return TEST_FILE_PATTERNS.some((re) => re.test(base));
}

/** True for a repo path worth reasoning about as code under test. */
export function isSourcePath(path: string): boolean {
  const normalized = normalize(path);
  if (isTestPath(normalized)) return false;

  const segments = normalized.split('/');
  if (segments.some((segment) => CONTEXT_EXCLUDED_SEGMENTS.has(segment))) return false;

  const dot = normalized.lastIndexOf('.');
  if (dot === -1) return false;
  return CONTEXT_SOURCE_EXTENSIONS.has(normalized.slice(dot).toLowerCase());
}

/**
 * The basename with any test/spec decoration stripped and lowercased.
 *
 * `src/user/service.ts` -> `service`, `tests/test_service.py` -> `service`,
 * `FooTest.kt` -> `foo`. This is the join key between a source file and its
 * conventional tests.
 */
export function sourceStem(path: string): string {
  const base = normalize(path).split('/').pop() ?? '';
  return base
    .replace(/\.[^.]+$/, '')
    .replace(/(?:\.(?:test|spec)|_(?:test|spec)|Test)$/, '')
    .replace(/^test_/, '')
    .replace(/(?:\.(?:test|spec)|_(?:test|spec)|Test)$/, '')
    .toLowerCase();
}

/** True when `testPath` looks like the test for `sourcePath` by stem. */
export function matchesRelated(sourcePath: string, testPath: string): boolean {
  if (!isTestPath(testPath)) return false;
  const stem = sourceStem(sourcePath);
  return stem.length > 0 && stem === sourceStem(testPath);
}

export interface TestDiscovery {
  changedSources: string[];
  changedTests: string[];
  relatedTests: string[];
}

/**
 * Pure discovery: given the full repository listing and the changed paths,
 * returns the changed sources to reason about, the changed test files, and the
 * existing tests whose name matches one of those sources.
 */
export function discoverRelatedTests(allPaths: string[], changedPaths: string[]): TestDiscovery {
  const changedSources = changedPaths.filter(isSourcePath).slice(0, MAX_TEST_SOURCES);
  const changedTests = changedPaths.filter(isTestPath);

  const seen = new Set<string>();
  const relatedTests: string[] = [];
  for (const candidate of allPaths) {
    if (relatedTests.length >= MAX_RELATED_TESTS) break;
    if (seen.has(candidate)) continue;
    if (changedPaths.includes(candidate)) continue;
    if (!changedSources.some((source) => matchesRelated(source, candidate))) continue;

    seen.add(candidate);
    relatedTests.push(candidate);
  }

  return { changedSources, changedTests, relatedTests };
}

async function readExcerpts(
  ghService: GitHubService,
  owner: string,
  repo: string,
  ref: string,
  paths: string[],
): Promise<Array<{ path: string; content: string }>> {
  const results = await Promise.all(
    paths.map(async (path) => {
      try {
        const content = await ghService.getFileContent(owner, repo, path, ref);
        if (!content) return null;
        return { path, content: content.slice(0, MAX_TEST_EXCERPT_CHARS) };
      } catch {
        return null;
      }
    }),
  );

  return results.filter((row): row is { path: string; content: string } => row !== null);
}

export interface CollectTestGapInputOptions {
  ghService: GitHubService;
  owner: string;
  repo: string;
  ref: string;
  changedPaths: string[];
}

/**
 * Gathers the bounded bundle handed to a provider, or `null` when the change
 * contains no code under test.
 *
 * Failure is safe: a missing or throwing tree listing degrades to
 * changed-paths-only discovery, and a file that cannot be read is simply
 * absent. Either way `incomplete` records that the view was partial.
 */
export async function collectTestGapInput(
  options: CollectTestGapInputOptions,
): Promise<TestGapInput | null> {
  const { ghService, owner, repo, ref, changedPaths } = options;

  let treePaths: string[] = [];
  let treeTruncated = false;
  let treeMissing = false;
  try {
    const tree = await ghService.getTree(owner, repo, ref);
    if (tree) {
      treePaths = tree.files.map((file) => file.path);
      treeTruncated = tree.truncated;
    } else {
      treeMissing = true;
    }
  } catch {
    treeMissing = true;
  }

  const discovery = discoverRelatedTests(treePaths, changedPaths);
  if (discovery.changedSources.length === 0) return null;

  const sourceExcerpts = await readExcerpts(ghService, owner, repo, ref, discovery.changedSources);
  const relatedTestExcerpts = await readExcerpts(
    ghService,
    owner,
    repo,
    ref,
    discovery.relatedTests,
  );

  const incomplete =
    treeMissing ||
    sourceExcerpts.length < discovery.changedSources.length ||
    relatedTestExcerpts.length < discovery.relatedTests.length;

  return {
    changedSources: discovery.changedSources,
    changedTests: discovery.changedTests,
    relatedTests: discovery.relatedTests,
    sourceExcerpts,
    relatedTestExcerpts,
    treeTruncated,
    incomplete,
  };
}
