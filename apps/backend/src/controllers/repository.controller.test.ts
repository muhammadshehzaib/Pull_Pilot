import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockRepoFindMany,
  mockRepoFindFirst,
  mockRepoCreate,
  mockRepoUpdate,
  mockJobCreate,
  mockQueueAdd,
  mockGetRepo,
  mockCreateWebhook,
  mockDeleteWebhook,
  mockGetPullRequest,
  GitHubServiceCtor,
} = vi.hoisted(() => {
  const mockRepoFindMany = vi.fn();
  const mockRepoFindFirst = vi.fn();
  const mockRepoCreate = vi.fn();
  const mockRepoUpdate = vi.fn();
  const mockJobCreate = vi.fn();
  const mockQueueAdd = vi.fn();
  const mockGetRepo = vi.fn();
  const mockCreateWebhook = vi.fn();
  const mockDeleteWebhook = vi.fn();
  const mockGetPullRequest = vi.fn();

  const GitHubServiceCtor = vi.fn(function (this: any) {
    this.getRepo = mockGetRepo;
    this.createWebhook = mockCreateWebhook;
    this.deleteWebhook = mockDeleteWebhook;
    this.getPullRequest = mockGetPullRequest;
  });

  return {
    mockRepoFindMany,
    mockRepoFindFirst,
    mockRepoCreate,
    mockRepoUpdate,
    mockJobCreate,
    mockQueueAdd,
    mockGetRepo,
    mockCreateWebhook,
    mockDeleteWebhook,
    mockGetPullRequest,
    GitHubServiceCtor,
  };
});

vi.mock('../config/prisma', () => ({
  default: {
    repository: {
      findMany: mockRepoFindMany,
      findFirst: mockRepoFindFirst,
      create: mockRepoCreate,
      update: mockRepoUpdate,
    },
    analysisJob: { create: mockJobCreate },
  },
}));

vi.mock('../services/github.service', () => ({
  GitHubService: GitHubServiceCtor,
}));

vi.mock('../config/queue', () => ({
  analysisQueue: { add: mockQueueAdd },
}));

import { RepositoryController } from './repository.controller';
import { mockReq, mockRes } from '../test-utils/express-mocks';

const authedReq = (overrides = {}) => {
  const req = mockReq(overrides);
  (req as any).auth = { userId: 'u-1', githubId: 'gh' };
  return req;
};

beforeEach(() => {
  vi.clearAllMocks();
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

    expect(res.json).toHaveBeenCalledWith({ repositories: [] });
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

    expect(mockGetRepo).toHaveBeenCalledWith('octo', 'cat');
    expect(mockCreateWebhook).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    const out = res.json.mock.calls[0][0];
    expect(out.repository.githubRepoId).toBe('99');
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
    );
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({ jobId: 'job-1', status: 'QUEUED' });
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
