import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRepoFindMany, mockRepoUpdate, mockJobCreate, mockQueueAdd, mockRedisGet, mockRedisSet } =
  vi.hoisted(() => ({
    mockRepoFindMany: vi.fn(),
    mockRepoUpdate: vi.fn(),
    mockJobCreate: vi.fn(),
    mockQueueAdd: vi.fn(),
    mockRedisGet: vi.fn(),
    mockRedisSet: vi.fn(),
  }));

vi.mock('../config/prisma', () => ({
  default: {
    repository: { findMany: mockRepoFindMany, update: mockRepoUpdate },
    analysisJob: { create: mockJobCreate },
  },
}));

vi.mock('../config/queue', () => ({
  analysisQueue: { add: mockQueueAdd },
}));

vi.mock('../config/redis', () => ({
  redisConnection: { get: mockRedisGet, set: mockRedisSet },
}));

import { pollRepositoriesOnce } from './repo-poller';

// pollRepositoriesOnce accepts the GitHub service as a parameter, so the
// GitHub API is faked by injection rather than by mocking octokit.
function fakeGitHub({ headSha = undefined, pulls = [] }: { headSha?: string; pulls?: any[] }) {
  return {
    getLatestCommitSha: vi.fn().mockResolvedValue(headSha),
    listOpenPullRequests: vi.fn().mockResolvedValue(pulls),
  } as any;
}

const repoRow = (overrides: Record<string, any> = {}) => ({
  id: 'r-1',
  fullName: 'octo/cat',
  lastScannedSha: null,
  user: { id: 'u-1', username: 'octo' },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GITHUB_ACCESS_TOKEN = 'ghp-bot';
  mockJobCreate.mockResolvedValue({ id: 'job-1' });
  mockRedisGet.mockResolvedValue(null);
});

describe('repo poller — default branch', () => {
  it('only records a baseline on the first sighting (no review of pre-existing history)', async () => {
    mockRepoFindMany.mockResolvedValueOnce([repoRow()]);

    await pollRepositoriesOnce(fakeGitHub({ headSha: 'sha-A' }));

    expect(mockJobCreate).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockRepoUpdate).toHaveBeenCalledWith({
      where: { id: 'r-1' },
      data: { lastScannedSha: 'sha-A' },
    });
  });

  it('polls the stored default branch when one is known', async () => {
    mockRepoFindMany.mockResolvedValueOnce([repoRow({ defaultBranch: 'develop' })]);
    const gh = fakeGitHub({ headSha: 'sha-A' });

    await pollRepositoriesOnce(gh);

    expect(gh.getLatestCommitSha).toHaveBeenCalledWith('octo', 'cat', 'develop');
  });

  it('queues a PUSH review for the range since the last seen head', async () => {
    mockRepoFindMany.mockResolvedValueOnce([repoRow({ lastScannedSha: 'sha-A' })]);

    await pollRepositoriesOnce(fakeGitHub({ headSha: 'sha-B' }));

    expect(mockJobCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventType: 'PUSH', referenceId: 'sha-B' }),
    });
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'poll-PUSH-sha-B',
      expect.objectContaining({
        userId: 'u-1',
        payloadSnapshot: { headSha: 'sha-B', baseSha: 'sha-A' },
      }),
    );
    expect(mockRepoUpdate).toHaveBeenCalledWith({
      where: { id: 'r-1' },
      data: { lastScannedSha: 'sha-B' },
    });
  });

  it('does nothing when the head is unchanged', async () => {
    mockRepoFindMany.mockResolvedValueOnce([repoRow({ lastScannedSha: 'sha-A' })]);

    await pollRepositoriesOnce(fakeGitHub({ headSha: 'sha-A' }));

    expect(mockJobCreate).not.toHaveBeenCalled();
    expect(mockRepoUpdate).not.toHaveBeenCalled();
  });
});

describe('repo poller — pull requests', () => {
  const pr = {
    number: 7,
    user: { login: 'Octo' }, // case differs from username on purpose
    head: { sha: 'pr-head' },
    base: { sha: 'pr-base' },
  };

  it('queues a PULL_REQUEST review for the connected user own PR and marks it seen', async () => {
    mockRepoFindMany.mockResolvedValueOnce([repoRow({ lastScannedSha: 'sha-A' })]);

    await pollRepositoriesOnce(fakeGitHub({ headSha: 'sha-A', pulls: [pr] }));

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'poll-PULL_REQUEST-7',
      expect.objectContaining({
        eventType: 'PULL_REQUEST',
        referenceId: '7',
        payloadSnapshot: { headSha: 'pr-head', baseSha: 'pr-base' },
      }),
    );
    expect(mockRedisSet).toHaveBeenCalledWith('pr-scanned:r-1:7:pr-head', '1');
  });

  it('skips a PR head that was already reviewed', async () => {
    mockRepoFindMany.mockResolvedValueOnce([repoRow({ lastScannedSha: 'sha-A' })]);
    mockRedisGet.mockResolvedValueOnce('1');

    await pollRepositoriesOnce(fakeGitHub({ headSha: 'sha-A', pulls: [pr] }));

    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('ignores PRs authored by other users', async () => {
    mockRepoFindMany.mockResolvedValueOnce([repoRow({ lastScannedSha: 'sha-A' })]);
    const foreignPr = { ...pr, user: { login: 'someone-else' } };

    await pollRepositoriesOnce(fakeGitHub({ headSha: 'sha-A', pulls: [foreignPr] }));

    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalled();
  });
});

describe('repo poller — resilience', () => {
  it('a failing repo does not stop the others from being polled', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockRepoFindMany.mockResolvedValueOnce([
      repoRow({ id: 'r-bad', fullName: 'octo/broken' }),
      repoRow({ id: 'r-good', lastScannedSha: 'sha-A' }),
    ]);
    const gh = {
      getLatestCommitSha: vi
        .fn()
        .mockRejectedValueOnce(new Error('GitHub 500'))
        .mockResolvedValueOnce('sha-B'),
      listOpenPullRequests: vi.fn().mockResolvedValue([]),
    } as any;

    await pollRepositoriesOnce(gh);

    expect(mockQueueAdd).toHaveBeenCalledWith('poll-PUSH-sha-B', expect.anything());
  });

  it('bails out silently when the bot token is not configured', async () => {
    delete process.env.GITHUB_ACCESS_TOKEN;

    await pollRepositoriesOnce();

    expect(mockRepoFindMany).not.toHaveBeenCalled();
  });
});
