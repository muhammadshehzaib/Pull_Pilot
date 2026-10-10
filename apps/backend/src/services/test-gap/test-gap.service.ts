import { GitHubService } from '../github.service';
import { collectTestGapInput } from './test-discovery.service';
import type {
  TestGapEvidence,
  TestGapInput,
  TestGapReport,
  TestGapScenario,
} from './test-gap-types';

/**
 * The minimal provider surface this step needs.
 *
 * Typed structurally rather than as `BaseAiProvider` so the worker's test
 * doubles — plain objects exposing only `analyzeCode` — keep working: the
 * `typeof` guard below is exactly the "optional capability" check.
 */
export interface TestGapProvider {
  analyzeTestGaps?: (
    input: TestGapInput,
    options?: { signal?: AbortSignal },
  ) => Promise<TestGapScenario[]>;
}

export interface RunTestGapOptions {
  ghService: GitHubService;
  owner: string;
  repo: string;
  ref: string;
  changedPaths: string[];
  provider?: TestGapProvider;
  signal?: AbortSignal;
}

/**
 * Runs the whole best-effort test-gap step and returns a report to persist, or
 * null when there is nothing to do.
 *
 * Contract:
 *  - Returns null when the change has no source files, or the provider cannot
 *    do test-gap analysis at all. The caller persists nothing.
 *  - Never throws for an ordinary failure: a discovery or model error yields a
 *    report with `analyzed: false` and a reason, so the review is unaffected.
 *  - Re-throws only when the supplied signal was aborted, so cancellation and
 *    timeout still unwind the worker rather than being swallowed here.
 */
export async function runTestGapAnalysis(
  options: RunTestGapOptions,
): Promise<TestGapReport | null> {
  const { provider, signal } = options;

  if (typeof provider?.analyzeTestGaps !== 'function') return null;

  let input: TestGapInput | null;
  try {
    input = await collectTestGapInput(options);
  } catch (error) {
    if (signal?.aborted) throw error;
    console.warn('⚠️ Test-gap discovery failed, skipping:', (error as Error).message);
    return null;
  }
  if (!input) return null;

  const evidence: TestGapEvidence = {
    changedSources: input.changedSources,
    relatedTests: input.relatedTests,
    treeTruncated: input.treeTruncated,
    incomplete: input.incomplete,
  };

  try {
    const scenarios = await provider.analyzeTestGaps(input, { signal });
    return { scenarios, evidence, analyzed: true };
  } catch (error) {
    if (signal?.aborted) throw error;
    console.warn('⚠️ Test-gap analysis failed, continuing without it:', (error as Error).message);
    return { scenarios: [], evidence, analyzed: false, reason: (error as Error).message };
  }
}
