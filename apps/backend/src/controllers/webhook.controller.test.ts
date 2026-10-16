import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../workers/review-recovery', () => ({ cancelDisconnectedReviews: vi.fn(async () => {}) }));
vi.mock('../services/comment-delivery.service', () => ({ purgeRepositoryDeliveryPayloads: vi.fn(async () => {}) }));

const {
  mockRepoFindFirst,
  mockRepoFindMany,
  mockRepoCreate,
  mockRepoUpdate,
  mockRepoUpdateMany,
  mockRepoUpsert,
  mockJobCreate,
  mockQueueAdd,
  mockInstallationUpsert,
  mockInstallationDeleteMany,
  mockInstallationFindUnique,
  mockCachedFileDeleteMany,
} = vi.hoisted(() => ({
  mockRepoFindFirst: vi.fn(),
  mockRepoFindMany: vi.fn(async (args: any) => {
    if (!args?.where?.githubRepoId) return [];
    const result = await mockRepoFindFirst(args);
    return result ? [result] : [];
  }),
  mockRepoCreate: vi.fn(),
  mockRepoUpdate: vi.fn(),
  mockRepoUpdateMany: vi.fn(),
  mockRepoUpsert: vi.fn(),
  mockJobCreate: vi.fn(),
  mockQueueAdd: vi.fn(),
  mockInstallationUpsert: vi.fn(),
  mockInstallationDeleteMany: vi.fn(),
  mockInstallationFindUnique: vi.fn(),
  mockCachedFileDeleteMany: vi.fn(),
}));

vi.mock('../config/prisma', () => ({
  default: {
    repository: {
      findFirst: mockRepoFindFirst,
      findMany: mockRepoFindMany,
      create: mockRepoCreate,
      update: mockRepoUpdate,
      updateMany: mockRepoUpdateMany,
      upsert: mockRepoUpsert,
    },
    installation: {
      upsert: mockInstallationUpsert,
      deleteMany: mockInstallationDeleteMany,
      findUnique: mockInstallationFindUnique,
    },
    analysisJob: { create: mockJobCreate },
    usageLedger: { upsert: vi.fn() },
    cachedFile: { deleteMany: mockCachedFileDeleteMany },
    cachedImport: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  },
}));

vi.mock('../config/queue', () => ({
  analysisQueue: { add: mockQueueAdd },
}));

vi.mock('../services/quota.service', () => ({
  QuotaService: {
    checkQuota: vi.fn().mockResolvedValue({ allowed: true, usage: { current: 0, limit: 50 } }),
    reserveReview: vi.fn().mockResolvedValue({ allowed: true, usage: { current: 1, limit: 50 } }),
    getQuotaExceededComment: vi.fn(() => 'quota exceeded'),
  },
}));

import { WebhookController } from './webhook.controller';
import { mockReq, mockRes } from '../test-utils/express-mocks';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('WebhookController.handleGitHubEvent — ping', () => {
  it('responds 200 pong to a ping event', async () => {
    const req = mockReq({ headers: { 'x-github-event': 'ping' }, body: {} });
    const res = mockRes();

    await WebhookController.handleGitHubEvent(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ message: 'pong' });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});

describe('WebhookController.handleGitHubEvent — installation', () => {
  it('registers new installation on action "created"', async () => {
    const req = mockReq({
      headers: { 'x-github-event': 'installation' },
      body: {
        action: 'created',
        installation: {
          id: 55555,
          account: { login: 'my-org', type: 'Organization', avatar_url: 'https://avatar.png' },
        },
      },
    });
    const res = mockRes();

    await WebhookController.handleGitHubEvent(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: 'PROCESSED', action: 'created' });
    expect(mockInstallationUpsert).toHaveBeenCalledWith({
      where: { githubInstallationId: BigInt(55555) },
      update: { accountLogin: 'my-org', accountType: 'Organization', avatarUrl: 'https://avatar.png' },
      create: {
        githubInstallationId: BigInt(55555),
        accountLogin: 'my-org',
        accountType: 'Organization',
        avatarUrl: 'https://avatar.png',
        createdByGithubId: null,
        plan: 'FREE',
      },
    });
  });

  it('deletes installation on action "deleted"', async () => {
    const req = mockReq({
      headers: { 'x-github-event': 'installation' },
      body: {
        action: 'deleted',
        installation: { id: 55555, account: { login: 'my-org' } },
      },
    });
    const res = mockRes();

    await WebhookController.handleGitHubEvent(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockInstallationDeleteMany).toHaveBeenCalledWith({
      where: { githubInstallationId: BigInt(55555) },
    });
  });

  it('clears cached code for the installation repositories before deleting it', async () => {
    // The installation -> repository relation is onDelete: SetNull, so deleting
    // the installation leaves repositories (and their copied code) behind.
    // The cache must be cleared first, while the link still exists.
    mockRepoFindMany.mockResolvedValueOnce([{ id: 'r1' }, { id: 'r2' }]);

    const req = mockReq({
      headers: { 'x-github-event': 'installation' },
      body: { action: 'deleted', installation: { id: 55555, account: { login: 'my-org' } } },
    });
    const res = mockRes();

    await WebhookController.handleGitHubEvent(req, res);

    expect(mockRepoFindMany).toHaveBeenCalledWith({
      where: { installation: { githubInstallationId: BigInt(55555) } },
      select: { id: true },
    });
    expect(mockCachedFileDeleteMany).toHaveBeenCalledWith({ where: { repositoryId: 'r1' } });
    expect(mockCachedFileDeleteMany).toHaveBeenCalledWith({ where: { repositoryId: 'r2' } });
    expect(mockInstallationDeleteMany).toHaveBeenCalledWith({
      where: { githubInstallationId: BigInt(55555) },
    });
  });

  it('still deletes the installation when it has no repositories', async () => {
    mockRepoFindMany.mockResolvedValueOnce([]);

    const req = mockReq({
      headers: { 'x-github-event': 'installation' },
      body: { action: 'deleted', installation: { id: 55555, account: { login: 'my-org' } } },
    });
    const res = mockRes();

    await WebhookController.handleGitHubEvent(req, res);

    expect(mockCachedFileDeleteMany).not.toHaveBeenCalled();
    expect(mockInstallationDeleteMany).toHaveBeenCalled();
  });
});

describe('WebhookController.handleGitHubEvent — installation_repositories', () => {
  const installationReposBody = (action: string, repos: unknown[]) => ({
    action,
    installation: { id: 55555 },
    [`repositories_${action}`]: repos,
  });

  it('clears cached code and deactivates a repository removed from the installation', async () => {
    mockInstallationFindUnique.mockResolvedValueOnce({ id: 'inst-1', userId: 'u-1' });
    mockRepoFindMany.mockResolvedValueOnce([{ id: 'r1' }]);

    const req = mockReq({
      headers: { 'x-github-event': 'installation_repositories' },
      body: installationReposBody('removed', [{ id: 123, full_name: 'o/r' }]),
    });
    const res = mockRes();

    await WebhookController.handleGitHubEvent(req, res);

    expect(mockCachedFileDeleteMany).toHaveBeenCalledWith({ where: { repositoryId: 'r1' } });
    expect(mockRepoUpdateMany).toHaveBeenCalledWith({
      where: { githubRepoId: BigInt(123) },
      data: { isActive: false },
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('does not clear anything when repositories are added', async () => {
    mockInstallationFindUnique.mockResolvedValueOnce({ id: 'inst-1', userId: 'u-1' });
    mockRepoCreate.mockResolvedValueOnce({});

    const req = mockReq({
      headers: { 'x-github-event': 'installation_repositories' },
      body: installationReposBody('added', [{ id: 777, full_name: 'o/new', private: false }]),
    });
    const res = mockRes();

    await WebhookController.handleGitHubEvent(req, res);

    expect(mockCachedFileDeleteMany).not.toHaveBeenCalled();
    expect(mockRepoCreate).toHaveBeenCalled();
  });
});

describe('WebhookController.handleGitHubEvent — marketplace_purchase', () => {
  it('no longer treats marketplace_purchase as a billing event', async () => {
    // Billing moved to Polar. A stale GitHub Marketplace delivery must not
    // touch plan state; it should fall through to the normal repo handling.
    const req = mockReq({
      headers: { 'x-github-event': 'marketplace_purchase' },
      body: {
        action: 'purchased',
        marketplace_purchase: {
          account: { id: 123, login: 'octocat' },
          plan: { id: 1, name: 'Indie Plan' },
        },
      },
    });
    const res = mockRes();

    await WebhookController.handleGitHubEvent(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Invalid repository structure in payload',
    });
  });
});

describe('WebhookController.handleGitHubEvent — pull_request', () => {
  const baseRepo = { id: 'r1', userId: 'u-owner', isActive: true, isPrivate: false };
  const prBody = (action: string) => ({
    action,
    repository: { id: 123, full_name: 'o/r', private: false },
    pull_request: {
      number: 7,
      head: { sha: 'head-sha' },
      base: { sha: 'base-sha' },
    },
  });

  it('queues a PULL_REQUEST job when action is "opened"', async () => {
    mockRepoFindFirst.mockResolvedValueOnce(baseRepo);
    mockJobCreate.mockResolvedValueOnce({ id: 'job-1' });

    const req = mockReq({
      headers: { 'x-github-event': 'pull_request' },
      body: prBody('opened'),
    });
    const res = mockRes();

    await WebhookController.handleGitHubEvent(req, res);

    expect(mockJobCreate).toHaveBeenCalledWith({
      data: {
        repositoryId: 'r1',
        eventType: 'PULL_REQUEST',
        referenceId: '7',
        commitSha: 'head-sha',
        status: 'QUEUED',
      },
    });
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'analyze-PULL_REQUEST-7',
      expect.objectContaining({
        jobId: 'job-1',
        repositoryId: 'r1',
        userId: 'u-owner',
        fullName: 'o/r',
        eventType: 'PULL_REQUEST',
        referenceId: '7',
      }),
      { jobId: 'job-1' },
    );
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({
      status: 'QUEUED',
      jobId: 'job-1',
      message: expect.any(String),
    });
  });

  it('queues a job for action "synchronize" too', async () => {
    mockRepoFindFirst.mockResolvedValueOnce(baseRepo);
    mockJobCreate.mockResolvedValueOnce({ id: 'job-2' });

    const req = mockReq({
      headers: { 'x-github-event': 'pull_request' },
      body: prBody('synchronize'),
    });
    const res = mockRes();

    await WebhookController.handleGitHubEvent(req, res);

    expect(mockQueueAdd).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it('skips when action is "closed" / "labeled" etc.', async () => {
    mockRepoFindFirst.mockResolvedValueOnce(baseRepo);

    const req = mockReq({
      headers: { 'x-github-event': 'pull_request' },
      body: prBody('closed'),
    });
    const res = mockRes();

    await WebhookController.handleGitHubEvent(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: 'SKIPPED',
      reason: 'action-closed-ignored',
    });
    expect(mockJobCreate).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});

describe('WebhookController.handleGitHubEvent — push', () => {
  it('queues a PUSH job using the after SHA as referenceId', async () => {
    mockRepoFindFirst.mockResolvedValueOnce({ id: 'r1', userId: 'u-owner', isActive: true });
    mockJobCreate.mockResolvedValueOnce({ id: 'job-push-1' });

    const req = mockReq({
      headers: { 'x-github-event': 'push' },
      body: {
        repository: { id: 123, full_name: 'o/r' },
        after: 'after-sha',
        before: 'before-sha',
      },
    });
    const res = mockRes();

    await WebhookController.handleGitHubEvent(req, res);

expect(mockJobCreate).toHaveBeenCalledWith({
          data: {
            repositoryId: 'r1',
            eventType: 'PUSH',
            referenceId: 'after-sha',
            commitSha: 'after-sha',
            status: 'QUEUED',
          },
        });
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'analyze-PUSH-after-sha',
      expect.objectContaining({
        jobId: 'job-push-1',
        referenceId: 'after-sha',
      }),
      { jobId: 'job-push-1' },
    );
    expect(res.status).toHaveBeenCalledWith(202);
  });
});

describe('WebhookController.handleGitHubEvent — breaking path', () => {
  it('returns 400 when payload has no repository.full_name', async () => {
    const req = mockReq({
      headers: { 'x-github-event': 'pull_request' },
      body: { action: 'opened' },
    });
    const res = mockRes();

    await WebhookController.handleGitHubEvent(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringMatching(/repository/i) });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('skips unknown repos (not active in DB) with status 200', async () => {
    mockRepoFindFirst.mockResolvedValueOnce(null);

    const req = mockReq({
      headers: { 'x-github-event': 'pull_request' },
      body: {
        action: 'opened',
        repository: { id: 123, full_name: 'stranger/unregistered' },
        pull_request: { number: 1, head: { sha: 'h' }, base: { sha: 'b' } },
      },
    });
    const res = mockRes();

    await WebhookController.handleGitHubEvent(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: 'SKIPPED',
      reason: 'inactive-repository',
    });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('skips unsupported event types (e.g., "star")', async () => {
    mockRepoFindFirst.mockResolvedValueOnce({ id: 'r1', userId: 'u-owner', isActive: true });

    const req = mockReq({
      headers: { 'x-github-event': 'star' },
      body: { repository: { id: 123, full_name: 'o/r' } },
    });
    const res = mockRes();

    await WebhookController.handleGitHubEvent(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: 'SKIPPED',
      reason: 'unsupported-event-type',
    });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('returns 500 when DB write fails', async () => {
    mockRepoFindFirst.mockResolvedValueOnce({ id: 'r1', userId: 'u-owner', isActive: true });
    mockJobCreate.mockRejectedValueOnce(new Error('DB exploded'));

    const req = mockReq({
      headers: { 'x-github-event': 'pull_request' },
      body: {
        action: 'opened',
        repository: { id: 123, full_name: 'o/r' },
        pull_request: { number: 1, head: { sha: 'h' }, base: { sha: 'b' } },
      },
    });
    const res = mockRes();

    await WebhookController.handleGitHubEvent(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal processing error' });
  });
});

describe('WebhookController idempotency — duplicate webhook deliveries', () => {
  const baseRepo = { id: 'r1', userId: 'u-owner', isActive: true, isPrivate: false };
  const prBody = () => ({
    action: 'synchronize',
    repository: { id: 123, full_name: 'o/r', private: false },
    pull_request: { number: 7, head: { sha: 'head-sha' }, base: { sha: 'base-sha' } },
  });

  const uniqueViolation = () => {
    const err = new Error('Unique constraint failed on the fields: (`commitSha`)') as Error & {
      code: string;
    };
    err.code = 'P2002';
    return err;
  };

  it('acknowledges a redelivered webhook with 200 and queues nothing', async () => {
    mockRepoFindFirst.mockResolvedValueOnce(baseRepo);
    mockJobCreate.mockRejectedValueOnce(uniqueViolation());

    const req = mockReq({ headers: { 'x-github-event': 'pull_request' }, body: prBody() });
    const res = mockRes();

    await WebhookController.handleGitHubEvent(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'DUPLICATE' }),
    );
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('does not post duplicate comments: the second delivery never enqueues a job', async () => {
    mockRepoFindFirst.mockResolvedValueOnce(baseRepo);
    mockJobCreate.mockRejectedValueOnce(uniqueViolation());

    const res = mockRes();
    await WebhookController.handleGitHubEvent(
      mockReq({ headers: { 'x-github-event': 'pull_request' }, body: prBody() }),
      res,
    );

    expect(mockJobCreate).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('still reviews a genuinely new commit on the same PR', async () => {
    mockRepoFindFirst.mockResolvedValueOnce(baseRepo);
    mockJobCreate.mockResolvedValueOnce({ id: 'job-new' });

    const body = prBody();
    body.pull_request.head.sha = 'brand-new-sha'; // developer pushed again

    const req = mockReq({ headers: { 'x-github-event': 'pull_request' }, body });
    const res = mockRes();

    await WebhookController.handleGitHubEvent(req, res);

    expect(mockJobCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ commitSha: 'brand-new-sha' }),
    });
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it('detects a duplicate from the error message when no code is present', async () => {
    mockRepoFindFirst.mockResolvedValueOnce(baseRepo);
    mockJobCreate.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));

    const req = mockReq({ headers: { 'x-github-event': 'pull_request' }, body: prBody() });
    const res = mockRes();

    await WebhookController.handleGitHubEvent(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('does not swallow unrelated database failures', async () => {
    mockRepoFindFirst.mockResolvedValueOnce(baseRepo);
    mockJobCreate.mockRejectedValueOnce(new Error('connection terminated unexpectedly'));

    const req = mockReq({ headers: { 'x-github-event': 'pull_request' }, body: prBody() });
    const res = mockRes();

    await WebhookController.handleGitHubEvent(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('WebhookController idempotency — payloads with no head SHA', () => {
  // PostgreSQL treats NULLs as distinct inside a unique constraint, so a row
  // persisted with commitSha = NULL can never conflict with another one. Before
  // this was handled, a delivery arriving without a head SHA bypassed the index
  // entirely: every redelivery queued another job and charged the quota again.
  const baseRepo = { id: 'r1', userId: 'u-owner', isActive: true, isPrivate: false };

  const prWithoutSha = () => ({
    action: 'synchronize',
    repository: { id: 123, full_name: 'o/r', private: false },
    pull_request: { number: 7, base: { sha: 'base-sha' } },
  });

  const pushWithoutSha = () => ({
    repository: { id: 123, full_name: 'o/r', private: false },
    before: 'old-sha',
  });

  it('skips a pull_request delivery whose head SHA is missing', async () => {
    mockRepoFindFirst.mockResolvedValueOnce(baseRepo);
    mockJobCreate.mockResolvedValueOnce({ id: 'skipped-1' });

    const req = mockReq({
      headers: { 'x-github-event': 'pull_request' },
      body: prWithoutSha(),
    });
    const res = mockRes();

    await WebhookController.handleGitHubEvent(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: 'SKIPPED', reason: 'missing-head-sha' });
  });

  it('never enqueues a review for a SHA-less delivery', async () => {
    // The whole point: no second review, no second quota charge.
    mockRepoFindFirst.mockResolvedValueOnce(baseRepo);
    mockJobCreate.mockResolvedValueOnce({ id: 'skipped-1' });

    const res = mockRes();
    await WebhookController.handleGitHubEvent(
      mockReq({ headers: { 'x-github-event': 'pull_request' }, body: prWithoutSha() }),
      res,
    );

    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('skips a push delivery with no after SHA', async () => {
    mockRepoFindFirst.mockResolvedValueOnce(baseRepo);
    mockJobCreate.mockResolvedValueOnce({ id: 'skipped-1' });

    const req = mockReq({ headers: { 'x-github-event': 'push' }, body: pushWithoutSha() });
    const res = mockRes();

    await WebhookController.handleGitHubEvent(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('records why the review was declined so it is visible in history', async () => {
    mockRepoFindFirst.mockResolvedValueOnce(baseRepo);
    mockJobCreate.mockResolvedValueOnce({ id: 'skipped-1' });

    await WebhookController.handleGitHubEvent(
      mockReq({ headers: { 'x-github-event': 'pull_request' }, body: prWithoutSha() }),
      mockRes(),
    );

    expect(mockJobCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        repositoryId: 'r1',
        eventType: 'PULL_REQUEST',
        referenceId: '7',
        status: 'SKIPPED',
        results: expect.objectContaining({ reason: 'missing-head-sha' }),
      }),
    });
  });

  it('does not record a QUEUED row, so the review is never mistaken for real', async () => {
    mockRepoFindFirst.mockResolvedValueOnce(baseRepo);
    mockJobCreate.mockResolvedValueOnce({ id: 'skipped-1' });

    await WebhookController.handleGitHubEvent(
      mockReq({ headers: { 'x-github-event': 'pull_request' }, body: prWithoutSha() }),
      mockRes(),
    );

    expect(mockJobCreate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'QUEUED' }) }),
    );
  });

  it('still reviews normally when the head SHA is present', async () => {
    // Guard against the guard: the happy path must be untouched.
    mockRepoFindFirst.mockResolvedValueOnce(baseRepo);
    mockJobCreate.mockResolvedValueOnce({ id: 'job-1' });

    const req = mockReq({
      headers: { 'x-github-event': 'pull_request' },
      body: {
        action: 'synchronize',
        repository: { id: 123, full_name: 'o/r', private: false },
        pull_request: { number: 7, head: { sha: 'head-sha' }, base: { sha: 'base-sha' } },
      },
    });
    const res = mockRes();

    await WebhookController.handleGitHubEvent(req, res);

    expect(res.status).toHaveBeenCalledWith(202);
    expect(mockQueueAdd).toHaveBeenCalled();
  });

  it('returns 200 rather than 500 so GitHub does not retry the unresolvable payload', async () => {
    // A non-2xx would make GitHub redeliver forever, which is exactly the loop
    // the idempotency work is meant to stop.
    mockRepoFindFirst.mockResolvedValueOnce(baseRepo);
    mockJobCreate.mockResolvedValueOnce({ id: 'skipped-1' });

    const res = mockRes();
    await WebhookController.handleGitHubEvent(
      mockReq({ headers: { 'x-github-event': 'pull_request' }, body: prWithoutSha() }),
      res,
    );

    expect(res.status).not.toHaveBeenCalledWith(500);
  });
});
