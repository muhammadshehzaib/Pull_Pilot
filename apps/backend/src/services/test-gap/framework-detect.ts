/**
 * Best-effort test-framework detection.
 *
 * Pure and cheap: it looks at the names of related test files and the text of
 * the related tests (plus package.json when available) so the prompt can tell
 * the model which conventions to follow. When nothing is recognised it returns
 * `undefined` and the prompt simply omits the hint — a wrong guess is worse
 * than none.
 */

export interface DetectFrameworkInput {
  relatedTestPaths?: string[];
  relatedTestExcerpts?: Array<{ path: string; content: string }>;
  packageJson?: string | null;
}

export function detectTestFramework(input: DetectFrameworkInput): string | undefined {
  const haystack = [
    input.packageJson ?? '',
    ...(input.relatedTestExcerpts ?? []).map((file) => file.content),
  ].join('\n');

  if (/\bvitest\b/.test(haystack)) return 'vitest';
  if (/\b@jest\/globals\b|\bjest\b/.test(haystack)) return 'jest';
  if (/\b@playwright\/test\b/.test(haystack)) return 'playwright';
  if (/\bmocha\b/.test(haystack)) return 'mocha';
  if (/\bpytest\b|(^|\n)\s*def test_/.test(haystack)) return 'pytest';
  if (/\bRSpec\b/.test(haystack)) return 'rspec';
  if (/\bpackage\s+\w+_test\b|\btesting\.T\b/.test(haystack)) return 'go test';

  const paths = input.relatedTestPaths ?? [];
  if (paths.some((p) => /_test\.go$/i.test(p))) return 'go test';
  if (paths.some((p) => /(?:^|\/)test_.*\.py$/i.test(p) || /_test\.py$/i.test(p))) return 'pytest';
  if (paths.some((p) => /_spec\.rb$/i.test(p))) return 'rspec';
  if (paths.some((p) => /Test\.(?:java|kt|kts|cs|scala|swift)$/.test(p))) return 'junit-style';

  return undefined;
}
