import { describe, it, expect, vi } from 'vitest';
import {
  createTestPullRequest,
  testDraftBranchName,
  buildTestPrBody,
} from './test-pr.service';
import type { TestPrDraftInput } from './test-pr.service';

const baseSha = 'base-sha-1';
const draft: TestPrDraftInput = {
  id: 'draft-1234567890ab',
  targetPath: 'tests/a.test.ts',
  targetContent: 'it("x", () => {})',
  sourcePath: 'src/a.ts',
  baseBranch: 'main',
  baseSha,
  sourceHeadSha: 'source-sha-1',
  sourcePrNumber: 42,
  scenarioLabel: 'handles empty input',
};

function gh(overrides: Record<string, unknown> = {}) {
  return {
    getPullRequest: vi.fn(async () => ({ head: { sha: 'source-sha-1' } })),
    getBranchHeadSha: vi.fn(async (_o: string, _r: string, branch: string) =>
      branch === 'main' ? baseSha : null,
    ),
    createBranch: vi.fn(async () => {}),
    getFileContent: vi.fn(async () => null),
    upsertFile: vi.fn(async () => 'commit-new'),
    findPullRequestByHead: vi.fn(async () => null),
    createPullRequest: vi.fn(async () => ({ number: 7, htmlUrl: 'https://gh/pr/7' })),
    ...overrides,
  };
}

describe('createTestPullRequest', () => {
  it('refuses without explicit confirmation and never touches GitHub', async () => {
    const service = gh();
    await expect(
      createTestPullRequest({ ghService: service as any, owner: 'o', repo: 'r', draft, confirmed: false }),
    ).rejects.toMatchObject({ code: 'confirmation-required' });
    expect(service.createBranch).not.toHaveBeenCalled();
    expect(service.createPullRequest).not.toHaveBeenCalled();
  });

  it('creates a branch off the recorded base, commits the file, and opens a PR', async () => {
    const service = gh();
    const result = await createTestPullRequest({
      ghService: service as any,
      owner: 'o',
      repo: 'r',
      draft,
      confirmed: true,
    });

    const branchName = testDraftBranchName(draft.id);
    expect(service.createBranch).toHaveBeenCalledWith('o', 'r', branchName, baseSha);
    expect(service.upsertFile).toHaveBeenCalledWith(
      'o',
      'r',
      'tests/a.test.ts',
      draft.targetContent,
      expect.any(String),
      branchName,
    );
    expect(service.createPullRequest).toHaveBeenCalledWith(
      'o',
      'r',
      expect.stringContaining('AI-drafted'),
      branchName,
      'main',
      expect.stringContaining('not executed it'),
    );
    expect(result).toMatchObject({ prNumber: 7, prUrl: 'https://gh/pr/7', reused: false });
  });

  it('reuses an existing PR for the same branch (idempotent retry)', async () => {
    const service = gh({
      findPullRequestByHead: vi.fn(async () => ({ number: 3, htmlUrl: 'https://gh/pr/3' })),
    });
    const result = await createTestPullRequest({
      ghService: service as any,
      owner: 'o',
      repo: 'r',
      draft,
      confirmed: true,
    });

    expect(result).toMatchObject({ prNumber: 3, reused: true });
    expect(service.createBranch).not.toHaveBeenCalled();
    expect(service.createPullRequest).not.toHaveBeenCalled();
  });

  it('skips the commit when the file content is already on the branch', async () => {
    const service = gh({
      getBranchHeadSha: vi.fn(async (_o: string, _r: string, branch: string) =>
        branch === 'main' ? baseSha : 'branch-head',
      ),
      getFileContent: vi.fn(async () => draft.targetContent),
    });
    const result = await createTestPullRequest({
      ghService: service as any,
      owner: 'o',
      repo: 'r',
      draft,
      confirmed: true,
    });

    expect(service.createBranch).not.toHaveBeenCalled();
    expect(service.upsertFile).not.toHaveBeenCalled();
    expect(result.commitSha).toBe('branch-head');
  });

  it('stops with stale-base when the base has moved', async () => {
    const service = gh({
      getBranchHeadSha: vi.fn(async () => 'moved-sha'),
    });
    await expect(
      createTestPullRequest({ ghService: service as any, owner: 'o', repo: 'r', draft, confirmed: true }),
    ).rejects.toMatchObject({ code: 'stale-base' });
    expect(service.createBranch).not.toHaveBeenCalled();
  });

  it('stops with base-branch-missing when the base branch is gone', async () => {
    const service = gh({ getBranchHeadSha: vi.fn(async () => null) });
    await expect(
      createTestPullRequest({ ghService: service as any, owner: 'o', repo: 'r', draft, confirmed: true }),
    ).rejects.toMatchObject({ code: 'base-branch-missing' });
  });

  it('stops when the source PR head changed after draft generation', async () => {
    const service = gh({
      getPullRequest: vi.fn(async () => ({ head: { sha: 'new-source-sha' } })),
    });
    await expect(
      createTestPullRequest({ ghService: service as any, owner: 'o', repo: 'r', draft, confirmed: true }),
    ).rejects.toMatchObject({ code: 'stale-source' });
    expect(service.createBranch).not.toHaveBeenCalled();
  });

  it('reports base lookup failures instead of mislabeling them as a missing branch', async () => {
    const service = gh({
      getBranchHeadSha: vi.fn(async () => {
        throw new Error('GitHub rate limit');
      }),
    });
    await expect(
      createTestPullRequest({ ghService: service as any, owner: 'o', repo: 'r', draft, confirmed: true }),
    ).rejects.toMatchObject({ code: 'github-error', message: 'GitHub rate limit' });
    expect(service.createBranch).not.toHaveBeenCalled();
  });

  it('surfaces GitHub API failures as a coded error without writing a PR row', async () => {
    const service = gh({
      createPullRequest: vi.fn(async () => {
        throw new Error('422 Unprocessable Entity');
      }),
    });
    await expect(
      createTestPullRequest({ ghService: service as any, owner: 'o', repo: 'r', draft, confirmed: true }),
    ).rejects.toMatchObject({ code: 'github-error' });
  });
});

describe('buildTestPrBody', () => {
  it('labels the code AI-generated and unverified and links the source PR', () => {
    const body = buildTestPrBody('octo', draft);
    expect(body).toMatch(/AI-drafted tests/);
    expect(body).toMatch(/this service has \*\*not executed it\*\*/i);
    expect(body).toMatch(/Checks tab for the current CI result/i);
    expect(body).toContain('src/a.ts');
    expect(body).toContain('#42');
  });
});
