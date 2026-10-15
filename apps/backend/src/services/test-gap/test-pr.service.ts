import type { GitHubService } from '../github.service';

/** Generated tests remain drafts: publication can trigger secret-bearing customer CI. */

export type TestPrErrorCode =
  | 'confirmation-required'
  | 'stale-base'
  | 'stale-source'
  | 'base-branch-missing'
  | 'github-error'
  | 'write-disabled';

export class TestPrError extends Error {
  constructor(
    public readonly code: TestPrErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TestPrError';
  }
}

export interface TestPrDraftInput {
  id: string;
  /** Already validated repo-relative test path. */
  targetPath: string;
  /** Already validated text content. */
  targetContent: string;
  /** Source file the test covers, for the PR title/body. */
  sourcePath: string;
  baseBranch: string;
  baseSha: string;
  sourceHeadSha?: string | null;
  sourcePrNumber?: number | null;
  scenarioLabel?: string;
}

export interface CreateTestPrOptions {
  ghService: Pick<
    GitHubService,
    | 'getBranchHeadSha'
    | 'getPullRequest'
    | 'createBranch'
    | 'upsertFile'
    | 'getFileContent'
    | 'findPullRequestByHead'
    | 'createPullRequest'
  >;
  owner: string;
  repo: string;
  draft: TestPrDraftInput;
  /** Explicit developer confirmation. Absent/false is refused. */
  confirmed: boolean;
}

export interface CreateTestPrResult {
  branchName: string;
  /** Commit that added the file, or the branch head when it was already there. */
  commitSha: string | null;
  prNumber: number;
  prUrl: string;
  /** True when a previous attempt had already opened the PR. */
  reused: boolean;
}

export const TEST_DRAFT_PUBLICATION_BLOCKED_REASON =
  'Automatic test PR creation is disabled because generated tests could run in your CI with secrets. Download the draft, review it, and run it in an isolated environment without secrets.';

/** Compatibility entry point: no GitHub reads or writes until execution is isolated. */
export async function createTestPullRequest(options: CreateTestPrOptions): Promise<CreateTestPrResult> {
  if (!options.confirmed) {
    throw new TestPrError('confirmation-required', 'Creating a test PR requires explicit confirmation.');
  }
  throw new TestPrError('write-disabled', TEST_DRAFT_PUBLICATION_BLOCKED_REASON);
}

export type { CreateTestPrResult as TestPrResult };
