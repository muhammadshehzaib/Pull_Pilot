import type { GitHubService } from '../github.service';
import { collectTestGapInput } from './test-discovery.service';
import { buildTestDraftInput, type TestDraftResult } from './test-draft-types';
import type { TestGapScenario } from './test-gap-types';
import { detectTestFramework } from './framework-detect';

/**
 * The minimal provider surface this step needs.
 *
 * Typed structurally so a test double exposing only `analyzeCode` simply makes
 * the capability look absent, exactly like the test-gap step.
 */
export interface TestDraftProvider {
  generateTestDraft?: (
    input: ReturnType<typeof buildTestDraftInput>,
    options?: { signal?: AbortSignal },
  ) => Promise<TestDraftResult>;
}

export interface GenerateTestDraftOptions {
  ghService: GitHubService;
  owner: string;
  repo: string;
  /** Commit/PR head SHA whose contents the review saw. */
  ref: string;
  /** The source file the scenario belongs to. */
  sourcePath: string;
  scenario: TestGapScenario;
  provider?: TestDraftProvider;
  signal?: AbortSignal;
}

/**
 * Produces one AI-drafted test for a scenario, or `null` when the scenario's
 * source path is not actually code under test (discovery found nothing to read).
 *
 * Unlike test-gap analysis this is user-initiated, so a provider failure is
 * surfaced to the caller rather than swallowed — the user asked for a draft and
 * deserves to know why they did not get one. Aborting still rethrows.
 */
export async function generateTestDraftForScenario(
  options: GenerateTestDraftOptions,
): Promise<TestDraftResult | null> {
  const { ghService, owner, repo, ref, sourcePath, scenario, provider, signal } = options;

  if (!provider || typeof provider.generateTestDraft !== 'function') {
    throw new Error('The configured AI provider does not support test drafting.');
  }

  const base = await collectTestGapInput({
    ghService,
    owner,
    repo,
    ref,
    changedPaths: [sourcePath],
  });
  if (!base) return null;

  const packageJson = await readPackageJson(ghService, owner, repo, ref);
  const framework = detectTestFramework({
    relatedTestPaths: base.relatedTests,
    relatedTestExcerpts: base.relatedTestExcerpts,
    packageJson,
  });

  // Pin the scenario to the requested source path so a model-authored filePath
  // in the scenario snapshot can never redirect the draft's context.
  const lockedScenario: TestGapScenario = { ...scenario, filePath: sourcePath };

  return provider.generateTestDraft(buildTestDraftInput(base, lockedScenario, framework), { signal });
}

async function readPackageJson(
  ghService: GitHubService,
  owner: string,
  repo: string,
  ref: string,
): Promise<string | null> {
  try {
    return await ghService.getFileContent(owner, repo, 'package.json', ref);
  } catch {
    return null;
  }
}
