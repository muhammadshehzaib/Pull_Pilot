import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../workers/review-recovery', () => ({ cancelDisconnectedReviews: vi.fn(async () => {}) }));

vi.mock('../workers/historical-maintenance', () => ({ clearRepositoryHistory: vi.fn() }));
vi.mock('../services/comment-delivery.service', () => ({ purgeRepositoryDeliveryPayloads: vi.fn(async () => {}) }));
const {
  mockRepoFindMany,
  mockRepoCount,
  mockRepoFindFirst,
  mockRepoCreate,
  mockRepoUpdate,
  mockJobCreate,
  mockQueueAdd,
  mockCachedFileDeleteMany,
  mockGetRepo,
  mockCreateWebhook,
  mockDeleteWebhook,
  mockGetPullRequest,
  mockGetLatestCommitWithParent,
  GitHubServiceCtor,
} = vi.hoisted(() => {
  const mockRepoFindMany = vi.fn();
  const mockRepoCount = vi.fn();
  const mockRepoFindFirst = vi.fn();
  const mockRepoCreate = vi.fn();
  const mockRepoUpdate = vi.fn();
  const mockJobCreate = vi.fn();
  const mockQueueAdd = vi.fn();
  const mockCachedFileDeleteMany = vi.fn();
  const mockGetRepo = vi.fn();
  const mockCreateWebhook = vi.fn();
  const mockDeleteWebhook = vi.fn();
  const mockGetPullRequest = vi.fn();
  const mockGetLatestCommitWithParent = vi.fn();

  const GitHubServiceCtor = vi.fn(function (this: any) {
    this.getRepo = mockGetRepo;
    this.getRepoForUser = mockGetRepo;
    this.createWebhook = mockCreateWebhook;
    this.deleteWebhook = mockDeleteWebhook;
    this.getPullRequest = mockGetPullRequest;
    this.getLatestCommitWithParent = mockGetLatestCommitWithParent;
  });

  return {
    mockRepoFindMany,
    mockRepoCount,
    mockRepoFindFirst,
    mockRepoCreate,
    mockRepoUpdate,
    mockJobCreate,
    mockQueueAdd,
    mockCachedFileDeleteMany,
    mockGetRepo,
    mockCreateWebhook,
    mockDeleteWebhook,
    mockGetPullRequest,
    mockGetLatestCommitWithParent,
    GitHubServiceCtor,
  };
});

vi.mock('../config/prisma', () => ({
  default: {
    repository: {
      findMany: mockRepoFindMany,
      count: mockRepoCount,
      findFirst: mockRepoFindFirst,
      create: mockRepoCreate,
      update: mockRepoUpdate,
    },
    analysisJob: { create: mockJobCreate },
    cachedFile: { deleteMany: mockCachedFileDeleteMany },
    cachedImport: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  },
}));

vi.mock('../services/github.service', () => ({
  GitHubService: GitHubServiceCtor,
}));

vi.mock('../config/queue', () => ({
  analysisQueue: { add: mockQueueAdd },
}));

vi.mock('../services/quota.service', () => ({
  QuotaService: {
    reserveReview: vi.fn().mockResolvedValue({ allowed: true, usage: { current: 1, limit: 50 } }),
  },
}));

import { RepositoryController } from './repository.controller';
import { mockReq, mockRes } from '../test-utils/express-mocks';
import { RepositoryAccessError } from '../errors/repository-access.error';

const authedReq = (overrides = {}) => {
  const req = mockReq(overrides);
  (req as any).auth = { userId: 'u-1', githubId: '7' };
  return req;
};

beforeEach(() => {
  vi.clearAllMocks();
  // Two counts run per list call (total, then active); a default keeps tests
  // that do not assert on totals from seeing `undefined` in the metadata.
  mockRepoCount.mockResolvedValue(0);
  process.env.GITHUB_ACCESS_TOKEN = 'ghp_bot_token';
});

describe('RepositoryController.list', () => {
  it('returns repositories with BigInt githubRepoId coerced to string', async () => {
    mockRepoFindMany.mockResolvedValueOnce([
      { id: 'r1', fullName: 'a/b', githubRepoId: BigInt(123456789), isActive: true },
    ]);
    const req = authedReq();
    const res = mockRes();

    await RepositoryController.list(req, res);

    const arg = res.json.mock.calls[0][0];
    expect(arg.repositories[0].githubRepoId).toBe('123456789');
    expect(typeof arg.repositories[0].githubRepoId).toBe('string');
  });

  it('returns an empty array when user has no repos', async () => {
    mockRepoFindMany.mockResolvedValueOnce([]);
    const req = authedReq();
    const res = mockRes();

    await RepositoryController.list(req, res);

    expect(res.json).toHaveBeenCalledWith({
      repositories: [],
      pagination: { page: 1, limit: 50, total: 0, totalPages: 1 },
      activeCount: 0,
    });
  });

  it('defaults to page 1 with no skip', async () => {
    mockRepoFindMany.mockResolvedValueOnce([]);
    const req = authedReq();
    const res = mockRes();

    await RepositoryController.list(req, res);

    expect(mockRepoFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 50 }),
    );
  });

  it('derives skip from page and limit and reports the total', async () => {
    mockRepoFindMany.mockResolvedValueOnce([]);
    // Counted twice: once for the total, once scoped to active repos.
    mockRepoCount.mockResolvedValueOnce(60).mockResolvedValueOnce(55);
    const req = authedReq({ query: { page: '2', limit: '25' } });
    const res = mockRes();

    await RepositoryController.list(req, res);

    expect(mockRepoFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 25, take: 25 }),
    );
    expect(res.json.mock.calls[0][0].pagination).toEqual({
      page: 2,
      limit: 25,
      total: 60,
      totalPages: 3,
    });
    expect(res.json.mock.calls[0][0].activeCount).toBe(55);
  });

  it('clamps a bad page to 1 instead of returning an empty page', async () => {
    for (const bad of ['0', '-5', 'banana']) {
      mockRepoFindMany.mockResolvedValueOnce([]);
      const res = mockRes();

      await RepositoryController.list(authedReq({ query: { page: bad } }), res);

      expect(mockRepoFindMany.mock.calls.at(-1)![0], bad).toMatchObject({ skip: 0 });
      expect(res.json.mock.calls[0][0].pagination.page, bad).toBe(1);
    }
  });

  it('always scopes both counts to the auth user (regression guard against IDOR)', async () => {
    mockRepoFindMany.mockResolvedValueOnce([]);
    const req = authedReq();
    const res = mockRes();

    await RepositoryController.list(req, res);

    const [totalWhere, activeWhere] = mockRepoCount.mock.calls.map((c) => c[0].where);
    expect(totalWhere).toEqual({ userId: 'u-1' });
    expect(activeWhere).toEqual({ userId: 'u-1', isActive: true });
    expect(res.json.mock.calls[0][0].activeCount).toBe(0);
  });
});

describe('RepositoryController.register — happy path', () => {
  it('creates the repo and webhook and returns 201', async () => {
    mockRepoFindFirst.mockResolvedValueOnce(null); // not yet registered
    mockGetRepo.mockResolvedValueOnce({ id: 99 });
    mockCreateWebhook.mockResolvedValueOnce('hook-1');
    mockRepoCreate.mockResolvedValueOnce({
      id: 'r-new',
      fullName: 'octo/cat',
      githubRepoId: BigInt(99),
      webhookId: 'hook-1',
      isActive: true,
    });

    const req = authedReq({ body: { fullName: 'octo/cat' } });
    const res = mockRes();

    await RepositoryController.register(req, res);

    expect(mockGetRepo).toHaveBeenCalledWith('octo', 'cat', '7', expect.any(Object));
    expect(mockCreateWebhook).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    const out = res.json.mock.calls[0][0];
    expect(out.repository.githubRepoId).toBe('99');
  });

  it('persists the repository default branch from GitHub', async () => {
    mockRepoFindFirst.mockResolvedValueOnce(null);
    mockGetRepo.mockResolvedValueOnce({ id: 99, default_branch: 'develop' });
    mockCreateWebhook.mockResolvedValueOnce('hook-1');
    mockRepoCreate.mockResolvedValueOnce({
      id: 'r-new',
      fullName: 'octo/cat',
      githubRepoId: BigInt(99),
      defaultBranch: 'develop',
    });

    const req = authedReq({ body: { fullName: 'octo/cat' } });
    const res = mockRes();

    await RepositoryController.register(req, res);

    expect(mockRepoCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ defaultBranch: 'develop' }),
    });
  });

  it('still connects the repo (webhookId null + warning) when GitHub rejects a non-public webhook URL', async () => {
    mockRepoFindFirst.mockResolvedValueOnce(null);
    mockGetRepo.mockResolvedValueOnce({ id: 99 });
    mockCreateWebhook.mockRejectedValueOnce(
      new Error(
        `Validation Failed: {"resource":"Hook","code":"custom","field":"url","message":"url is not supported because it isn't reachable over the public Internet (localhost)"}`,
      ),
    );
    mockRepoCreate.mockResolvedValueOnce({
      id: 'r-new',
      fullName: 'octo/cat',
      githubRepoId: BigInt(99),
      webhookId: null,
      isActive: true,
    });

    const req = authedReq({ body: { fullName: 'octo/cat' } });
    const res = mockRes();

    await RepositoryController.register(req, res);

    expect(mockRepoCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ webhookId: null, isActive: true }),
    });
    expect(res.status).toHaveBeenCalledWith(201);
    const out = res.json.mock.calls[0][0];
    expect(out.repository.webhookId).toBeNull();
    expect(out.warning).toMatch(/not reachable from GitHub/);
  });

  it('reactivates a previously disconnected repo with a fresh webhook and returns 200', async () => {
    mockRepoFindFirst.mockResolvedValueOnce({
      id: 'r-old',
      githubRepoId: BigInt(99),
      fullName: 'octo/cat',
      isActive: false,
      webhookId: null,
    });
    mockGetRepo.mockResolvedValueOnce({ id: 99 });
    mockCreateWebhook.mockResolvedValueOnce('hook-2');
    mockRepoUpdate.mockResolvedValueOnce({
      id: 'r-old',
      fullName: 'octo/cat',
      githubRepoId: BigInt(99),
      webhookId: 'hook-2',
      isActive: true,
    });

    const req = authedReq({ body: { fullName: 'octo/cat' } });
    const res = mockRes();

    await RepositoryController.register(req, res);

    expect(mockCreateWebhook).toHaveBeenCalled();
    expect(mockRepoUpdate).toHaveBeenCalledWith({
      where: { id: 'r-old' },
      data: { githubRepoId: BigInt(99), webhookId: 'hook-2', isActive: true },
    });
    expect(mockRepoCreate).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    const out = res.json.mock.calls[0][0];
    expect(out.repository.githubRepoId).toBe('99');
    expect(out.repository.isActive).toBe(true);
  });
});

describe('RepositoryController.register — breaking path', () => {
  it.each(['o/r/extra', 'o/r?query', 'o/r#fragment', ' o/r', 'o/..', '/r', 'o/'])('rejects malformed fullName %j before GitHub lookup', async fullName => {
    const res = mockRes();
    await RepositoryController.register(authedReq({ body: { fullName } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockGetRepo).not.toHaveBeenCalled();
    expect(mockCreateWebhook).not.toHaveBeenCalled();
  });

  it.each([false, true])('denies a stranger before webhook/write, reconnect=%s', async reconnect => {
    mockRepoFindFirst.mockResolvedValueOnce(reconnect
      ? { id: 'old', githubRepoId: BigInt(99), isPrivate: true, isActive: false }
      : null);
    mockGetRepo.mockRejectedValueOnce(new RepositoryAccessError());
    const res = mockRes();
    await RepositoryController.register(authedReq({ body: { fullName: 'company/private', githubId: 'victim', username: 'victim' } }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockGetRepo).toHaveBeenCalledWith('company', 'private', '7', expect.any(Object));
    expect(mockCreateWebhook).not.toHaveBeenCalled();
    expect(mockRepoCreate).not.toHaveBeenCalled();
    expect(mockRepoUpdate).not.toHaveBeenCalled();
  });

  it('fails closed when GitHub access verification is unavailable', async () => {
    mockRepoFindFirst.mockResolvedValueOnce(null);
    mockGetRepo.mockRejectedValueOnce(new RepositoryAccessError(503));
    const res = mockRes();
    await RepositoryController.register(authedReq({ body: { fullName: 'company/private' } }), res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(mockCreateWebhook).not.toHaveBeenCalled();
    expect(mockRepoCreate).not.toHaveBeenCalled();
  });

  it('rejects an installation belonging to another user', async () => {
    mockRepoFindFirst.mockResolvedValueOnce({ id: 'old', isActive: false, installation: { userId: 'someone-else', githubInstallationId: BigInt(44) } });
    const res = mockRes();
    await RepositoryController.register(authedReq({ body: { fullName: 'company/private' } }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockGetRepo).not.toHaveBeenCalled();
    expect(mockCreateWebhook).not.toHaveBeenCalled();
  });

  it('preserves the cross-account ownership conflict after access verification', async () => {
    mockRepoFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'other-repo', userId: 'other-user' });
    mockGetRepo.mockResolvedValueOnce({ id: 99, private: true });
    const res = mockRes();
    await RepositoryController.register(authedReq({ body: { fullName: 'company/private' } }), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockCreateWebhook).not.toHaveBeenCalled();
    expect(mockRepoCreate).not.toHaveBeenCalled();
  });

  it('returns 400 when fullName is missing', async () => {
    const req = authedReq({ body: {} });
    const res = mockRes();

    await RepositoryController.register(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when fullName does not contain a slash', async () => {
    const req = authedReq({ body: { fullName: 'notarepo' } });
    const res = mockRes();

    await RepositoryController.register(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockGetRepo).not.toHaveBeenCalled();
  });

  it('returns 409 when the repo is already actively registered for this user', async () => {
    mockRepoFindFirst.mockResolvedValueOnce({ id: 'existing', isActive: true });
    const req = authedReq({ body: { fullName: 'octo/cat' } });
    const res = mockRes();

    await RepositoryController.register(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockGetRepo).not.toHaveBeenCalled();
  });

  it('returns 500 when GitHub API call fails', async () => {
    mockRepoFindFirst.mockResolvedValueOnce(null);
    mockGetRepo.mockRejectedValueOnce(new Error('404 Not Found'));
    const req = authedReq({ body: { fullName: 'octo/missing' } });
    const res = mockRes();

    await RepositoryController.register(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(mockRepoCreate).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ error: 'Could not connect repository' });
  });

  it('returns 500 when bot token is not configured', async () => {
    delete process.env.GITHUB_ACCESS_TOKEN;
    mockRepoFindFirst.mockResolvedValueOnce(null);
    const req = authedReq({ body: { fullName: 'octo/cat' } });
    const res = mockRes();

    await RepositoryController.register(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('RepositoryController.deactivate', () => {
  it('soft-deletes the repo and deletes the GitHub webhook', async () => {
    mockRepoFindFirst.mockResolvedValueOnce({
      id: 'r1',
      fullName: 'o/r',
      webhookId: '42',
    });
    mockDeleteWebhook.mockResolvedValueOnce({});
    mockRepoUpdate.mockResolvedValueOnce({});

    const req = authedReq({ params: { id: 'r1' } });
    const res = mockRes();

    await RepositoryController.deactivate(req, res);

    expect(mockDeleteWebhook).toHaveBeenCalledWith('o', 'r', 42);
    expect(mockRepoUpdate).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { isActive: false, webhookId: null },
    });
    expect(res.json).toHaveBeenCalledWith({ status: 'OK' });
  });

  it('deletes the cached code so disconnect actually removes the copied source', async () => {
    // Retention is indefinite, so deactivation alone would keep the copied
    // files forever. Disconnect must drop them.
    mockRepoFindFirst.mockResolvedValueOnce({ id: 'r1', fullName: 'o/r', webhookId: null });
    mockRepoUpdate.mockResolvedValueOnce({});

    const req = authedReq({ params: { id: 'r1' } });
    const res = mockRes();

    await RepositoryController.deactivate(req, res);

    expect(mockCachedFileDeleteMany).toHaveBeenCalledWith({ where: { repositoryId: 'r1' } });
  });

  it('still deactivates in DB when GitHub webhook delete fails (best-effort)', async () => {
    mockRepoFindFirst.mockResolvedValueOnce({
      id: 'r1',
      fullName: 'o/r',
      webhookId: '42',
    });
    mockDeleteWebhook.mockRejectedValueOnce(new Error('404 webhook already gone'));
    mockRepoUpdate.mockResolvedValueOnce({});

    const req = authedReq({ params: { id: 'r1' } });
    const res = mockRes();

    await RepositoryController.deactivate(req, res);

    expect(mockRepoUpdate).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ status: 'OK' });
  });

  it('returns 404 when the repo does not belong to the user', async () => {
    mockRepoFindFirst.mockResolvedValueOnce(null);
    const req = authedReq({ params: { id: 'r-foreign' } });
    const res = mockRes();

    await RepositoryController.deactivate(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockRepoUpdate).not.toHaveBeenCalled();
  });
});

describe('RepositoryController.triggerAnalysis', () => {
  it('resolves base/head from a PR number and queues the job', async () => {
    mockRepoFindFirst.mockResolvedValueOnce({
      id: 'r1',
      fullName: 'o/r',
      isActive: true,
    });
    mockGetPullRequest.mockResolvedValueOnce({
      head: { sha: 'head-sha' },
      base: { sha: 'base-sha' },
    });
    mockJobCreate.mockResolvedValueOnce({ id: 'job-1' });

    const req = authedReq({ params: { id: 'r1' }, body: { pullNumber: 42 } });
    const res = mockRes();

    await RepositoryController.triggerAnalysis(req, res);

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'manual-PULL_REQUEST-42',
      expect.objectContaining({
        jobId: 'job-1',
        eventType: 'PULL_REQUEST',
        payloadSnapshot: { headSha: 'head-sha', baseSha: 'base-sha' },
      }),
      { jobId: 'job-1' },
    );
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({ jobId: 'job-1', status: 'QUEUED' });
  });

  it('audits the stored default branch for a bare audit request', async () => {
    mockRepoFindFirst.mockResolvedValueOnce({
      id: 'r1',
      fullName: 'o/r',
      isActive: true,
      defaultBranch: 'main',
    });
    mockGetLatestCommitWithParent.mockResolvedValueOnce({
      headSha: 'h',
      baseSha: 'b',
      branch: 'main',
    });
    mockJobCreate.mockResolvedValueOnce({ id: 'job-branch' });

    const req = authedReq({ params: { id: 'r1' }, body: {} });
    const res = mockRes();

    await RepositoryController.triggerAnalysis(req, res);

    expect(mockGetLatestCommitWithParent).toHaveBeenCalledWith('o', 'r', 'main');
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'manual-PUSH-h',
      expect.objectContaining({ payloadSnapshot: { headSha: 'h', baseSha: 'b' } }),
      { jobId: 'job-branch' },
    );
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it('accepts an explicit { headSha, baseSha } pair as a PUSH job', async () => {
    mockRepoFindFirst.mockResolvedValueOnce({
      id: 'r1',
      fullName: 'o/r',
      isActive: true,
    });
    mockJobCreate.mockResolvedValueOnce({ id: 'job-2' });

    const req = authedReq({
      params: { id: 'r1' },
      body: { headSha: 'h', baseSha: 'b' },
    });
    const res = mockRes();

    await RepositoryController.triggerAnalysis(req, res);

    expect(mockGetPullRequest).not.toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'manual-PUSH-h',
      expect.objectContaining({ eventType: 'PUSH' }),
      { jobId: 'job-2' },
    );
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it('returns 404 when repo is inactive or not owned by user', async () => {
    mockRepoFindFirst.mockResolvedValueOnce(null);
    const req = authedReq({ params: { id: 'gone' }, body: { pullNumber: 1 } });
    const res = mockRes();

    await RepositoryController.triggerAnalysis(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('returns 400 when neither pullNumber nor (headSha+baseSha) is provided', async () => {
    mockRepoFindFirst.mockResolvedValueOnce({
      id: 'r1',
      fullName: 'o/r',
      isActive: true,
    });
    const req = authedReq({ params: { id: 'r1' }, body: {} });
    const res = mockRes();

    await RepositoryController.triggerAnalysis(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('returns 502 when GitHub PR lookup fails', async () => {
    mockRepoFindFirst.mockResolvedValueOnce({
      id: 'r1',
      fullName: 'o/r',
      isActive: true,
    });
    mockGetPullRequest.mockRejectedValueOnce(new Error('PR not found'));

    const req = authedReq({ params: { id: 'r1' }, body: { pullNumber: 999 } });
    const res = mockRes();

    await RepositoryController.triggerAnalysis(req, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(mockJobCreate).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});
