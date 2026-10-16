import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { pollSettings, mockRepoFindMany, mockRepoUpdate, mockJobCreate, mockQueueAdd, mockRedisGet, mockRedisSet } =
  vi.hoisted(() => ({
    pollSettings: { enabled: true },
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

vi.mock('../services/quota.service', () => ({
  QuotaService: {
    reserveReview: vi.fn().mockResolvedValue({ allowed: true, usage: { current: 1, limit: 50 } }),
  },
}));

vi.mock('../utils/constants', () => ({ get POLL_ENABLED() { return pollSettings.enabled; }, POLL_INTERVAL_MS: 1000 }));

import { pollRepositoriesOnce, startRepoPoller } from './repo-poller';
import { pollerHeadKey, POLLER_CACHE_TTL_SECONDS } from './poller-cache';

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
  pollSettings.enabled = true;
  process.env.GITHUB_ACCESS_TOKEN = 'ghp-bot';
  mockJobCreate.mockResolvedValue({ id: 'job-1' });
  mockRedisGet.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('repo poller — default branch', () => {
  it('only records a baseline on the first sighting (no review of pre-existing history)', async () => {
    mockRepoFindMany.mockResolvedValueOnce([repoRow()]);

    await pollRepositoriesOnce(fakeGitHub({ headSha: 'sha-A' }));
    expect(mockRepoFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { isActive: true, webhookId: null, installationId: null },
    }));

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
      { jobId: 'job-1' },
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
      { jobId: 'job-1' },
    );
    expect(mockRedisSet).toHaveBeenCalledWith(pollerHeadKey('r-1', 7), 'pr-head', 'EX', POLLER_CACHE_TTL_SECONDS);
  });

  it('skips a PR head that was already reviewed', async () => {
    mockRepoFindMany.mockResolvedValueOnce([repoRow({ lastScannedSha: 'sha-A' })]);
    mockRedisGet.mockResolvedValueOnce('pr-head');

    await pollRepositoriesOnce(fakeGitHub({ headSha: 'sha-A', pulls: [pr] }));

    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
  it('updates the same expiring cache slot when the PR gets another commit', async () => {
    mockRepoFindMany.mockResolvedValueOnce([repoRow({ lastScannedSha: 'sha-A' })]);
    mockRedisGet.mockResolvedValueOnce('old-head');
    await pollRepositoriesOnce(fakeGitHub({ headSha: 'sha-A', pulls: [pr] }));
    expect(mockRedisGet).toHaveBeenCalledWith(pollerHeadKey('r-1', 7));
    expect(mockRedisSet).toHaveBeenCalledWith(pollerHeadKey('r-1', 7), 'pr-head', 'EX', 604800);
    expect(mockQueueAdd).toHaveBeenCalledOnce();
  });
  it('does not queue or charge a duplicate review after the Redis entry expires', async () => {
    mockRepoFindMany.mockResolvedValueOnce([repoRow({ lastScannedSha: 'sha-A' })]);
    mockRedisGet.mockResolvedValueOnce(null);
    mockJobCreate.mockRejectedValueOnce({ code: 'P2002' });
    await pollRepositoriesOnce(fakeGitHub({ headSha: 'sha-A', pulls: [pr] }));
    expect(mockQueueAdd).not.toHaveBeenCalled();
    const { QuotaService } = await import('../services/quota.service');
    expect(QuotaService.reserveReview).not.toHaveBeenCalled();
    expect(mockRedisSet).toHaveBeenCalledWith(pollerHeadKey('r-1', 7), 'pr-head', 'EX', 604800);
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
  it('does not start a timer or query repositories unless explicitly enabled', async () => {
    vi.useFakeTimers(); pollSettings.enabled = false;
    expect(startRepoPoller()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockRepoFindMany).not.toHaveBeenCalled(); expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('handles the first database outage and recovers at the next scheduled tick', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const secret = 'database-password-must-not-be-logged';
    mockRepoFindMany.mockRejectedValueOnce(new Error(secret)).mockResolvedValue([]);

    const stop = startRepoPoller();
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledWith(
      'Repository polling cycle failed; retrying on the next scheduled check', {},
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockRepoFindMany).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    stop?.();
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockRepoFindMany).toHaveBeenCalledTimes(2);
  });

  it('handles a later scheduled outage and continues after database recovery', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockRepoFindMany.mockResolvedValueOnce([])
      .mockRejectedValueOnce(Object.assign(new Error('private connection string'), { code: 'ECONNREFUSED' }))
      .mockResolvedValue([]);

    startRepoPoller();
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockRepoFindMany).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(
      'Repository polling cycle failed; retrying on the next scheduled check', { code: 'ECONNREFUSED' },
    );
  });

  it('does not overlap slow polls and releases the guard after a rejection', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let rejectQuery!: (error: Error) => void;
    mockRepoFindMany.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectQuery = reject; }))
      .mockResolvedValue([]);

    startRepoPoller();
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockRepoFindMany).toHaveBeenCalledTimes(1);
    rejectQuery(new Error('temporary outage'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockRepoFindMany).toHaveBeenCalledTimes(2);
  });

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

    expect(mockQueueAdd).toHaveBeenCalledWith('poll-PUSH-sha-B', expect.anything(), { jobId: 'job-1' });
  });

  it('bails out silently when the bot token is not configured', async () => {
    delete process.env.GITHUB_ACCESS_TOKEN;

    await pollRepositoriesOnce();

    expect(mockRepoFindMany).not.toHaveBeenCalled();
  });
});
