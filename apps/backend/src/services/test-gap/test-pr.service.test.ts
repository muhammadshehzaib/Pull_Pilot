import { describe, it, expect, vi } from 'vitest';
import { createTestPullRequest } from './test-pr.service';

describe('test draft publication is blocked', () => {
  it.each(['tests/conftest.py', 'tests/setup.ts', 'tests/a.test.ts'])(
    'never publishes executable input at %s despite confirmation', async targetPath => {
      const ghService = new Proxy({}, { get: () => { throw new Error('No GitHub API may be accessed'); } });
      await expect(createTestPullRequest({ ghService: ghService as any, owner: 'o', repo: 'r', confirmed: true,
        draft: { id: 'draft', targetPath, targetContent: 'unsafe executable code', sourcePath: 'src/a.ts', baseBranch: 'main', baseSha: 'sha' },
      })).rejects.toMatchObject({ code: 'write-disabled' });
    },
  );
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
