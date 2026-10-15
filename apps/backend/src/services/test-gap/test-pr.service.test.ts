import { describe, it, expect, vi } from 'vitest';
import { createTestPullRequest } from './test-pr.service';

describe('test draft publication is blocked', () => {
  it.each([false, true])('never calls GitHub even when confirmed=%s', async confirmed => {
    const service = {
      getPullRequest: vi.fn(), getBranchHeadSha: vi.fn(), createBranch: vi.fn(),
      getFileContent: vi.fn(), upsertFile: vi.fn(), findPullRequestByHead: vi.fn(), createPullRequest: vi.fn(),
    };
    await expect(createTestPullRequest({ ghService: service, owner: 'o', repo: 'r', confirmed,
      draft: { id: 'draft', targetPath: 'tests/a.test.ts', targetContent: 'test("example", () => {})',
        sourcePath: 'src/a.ts', baseBranch: 'main', baseSha: 'sha' },
    })).rejects.toMatchObject({ code: confirmed ? 'write-disabled' : 'confirmation-required' });
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
  });
});
