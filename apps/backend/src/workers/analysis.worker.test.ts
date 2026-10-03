import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The worker module does `new Worker(QUEUE_NAME, handler, opts)` at import time.
 * To test the handler in isolation we mock the bullmq Worker class, capture the
 * handler that the source code passes in, and then invoke it directly with
 * fake job payloads.
 */
const { capturedHandler, WorkerMock, mockJobUpdate, mockRepoFindUnique, mockDecrypt, mockFetchDiff, mockCreateReviewComment, mockGetProvider, mockAnalyzeCode, mockEmitStatus, GitHubServiceCtor } = vi.hoisted(() => {
  const capturedHandler: { fn?: (job: any) => Promise<any> } = {};

  const WorkerMock = vi.fn(function (this: any, _name: string, handler: any) {
    capturedHandler.fn = handler;
    this.on = vi.fn();
  });

  const mockJobUpdate = vi.fn();
  const mockRepoFindUnique = vi.fn();
  const mockDecrypt = vi.fn();
  const mockFetchDiff = vi.fn();
  const mockCreateReviewComment = vi.fn();
  const mockGetProvider = vi.fn();
  const mockAnalyzeCode = vi.fn();
  const mockEmitStatus = vi.fn();

  const GitHubServiceCtor = vi.fn(function (this: any) {
    this.fetchDiff = mockFetchDiff;
    this.createReviewComment = mockCreateReviewComment;
    this.createIssueComment = vi.fn();
    this.getFileContent = vi.fn().mockResolvedValue(null);
  });

  return {
    capturedHandler,
    WorkerMock,
    mockJobUpdate,
    mockRepoFindUnique,
    mockDecrypt,
    mockFetchDiff,
    mockCreateReviewComment,
    mockGetProvider,
    mockAnalyzeCode,
    mockEmitStatus,
    GitHubServiceCtor,
  };
});

vi.mock('bullmq', () => ({
  Worker: WorkerMock,
  // Mirrors BullMQ: thrown to tell the queue a job must not be retried.
  UnrecoverableError: class UnrecoverableError extends Error {
    constructor(message?: string) {
      super(message);
      this.name = 'UnrecoverableError';
    }
  },
}));

vi.mock('../config/redis', () => ({ redisConnection: { host: 'mock' } }));

vi.mock('../config/queue', () => ({
  ANALYSIS_QUEUE_NAME: 'test-queue',
}));

vi.mock('../config/prisma', () => ({
  default: {
    analysisJob: { update: mockJobUpdate },
    repository: { findUnique: mockRepoFindUnique },
  },
}));

vi.mock('../services/encryption.service', () => ({
  EncryptionService: { decrypt: mockDecrypt },
}));

vi.mock('../services/github.service', () => ({
  GitHubService: GitHubServiceCtor,
}));

vi.mock('../services/ai/ai-factory', () => ({
  AiProviderFactory: { getProvider: mockGetProvider },
}));

vi.mock('../config/socket', () => ({
  SocketService: { emitStatus: mockEmitStatus },
}));

import './analysis.worker';

function makeJobPayload(overrides: Record<string, any> = {}) {
  return {
    id: 'bullmq-job-1',
    data: {
      jobId: 'job-1',
      repositoryId: 'r-1',
      userId: 'u-owner',
      fullName: 'octo/cat',
      eventType: 'PULL_REQUEST',
      referenceId: '42',
      payloadSnapshot: { headSha: 'head-sha', baseSha: 'base-sha' },
      ...overrides,
    },
  };
}

const fullRepoWithVault = {
  user: {
    vault: {
      provider: 'CLAUDE',
      encryptedGeminiKey: 'ENC',
      iv: 'IV',
      authTag: 'TAG',
      salt: 'SALT',
    },
  },
};

beforeEach(() => {
  // resetAllMocks drains queued mockResolvedValueOnce/mockRejectedValueOnce
  // values AND clears call history — clearAllMocks only does the latter.
  vi.resetAllMocks();
  mockDecrypt.mockReturnValue('sk-decrypted');
  mockGetProvider.mockReturnValue({ analyzeCode: mockAnalyzeCode });
  process.env.GITHUB_ACCESS_TOKEN = 'ghp-bot';
});

describe('analysis worker — module wiring', () => {
  it('registers a handler with the bullmq Worker at import time', () => {
    // The handler was captured during top-of-file `import './analysis.worker'`.
    // resetAllMocks wipes call history, so we verify via the captured reference.
    expect(capturedHandler.fn).toBeTypeOf('function');
  });
});

describe('analysis worker — happy path', () => {
  it('runs the full pipeline: status RUNNING -> decrypt -> diff -> AI -> COMPLETED + posts comments on PR', async () => {
    mockRepoFindUnique.mockResolvedValueOnce(fullRepoWithVault);
    mockFetchDiff.mockResolvedValueOnce('diff --git a/foo b/foo\n+ x');
    mockAnalyzeCode.mockResolvedValueOnce([
      {
        filePath: 'foo.ts',
        lineNumber: 10,
        agentType: 'SECURITY',
        issue: 'x',
        suggestion: 'y',
        priority: 'HIGH',
      },
    ]);

    const result = await capturedHandler.fn!(makeJobPayload());

    // Set RUNNING first, then COMPLETED with results
    expect(mockJobUpdate).toHaveBeenNthCalledWith(1, {
      where: { id: 'job-1' },
      data: { status: 'RUNNING' },
    });
    expect(mockJobUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'COMPLETED' }),
      }),
    );

    expect(mockDecrypt).toHaveBeenCalledWith('ENC', 'IV', 'TAG', 'SALT');
    expect(mockGetProvider).toHaveBeenCalledWith('CLAUDE', 'sk-decrypted');
    expect(mockFetchDiff).toHaveBeenCalledWith('octo', 'cat', 'base-sha', 'head-sha');
    expect(mockCreateReviewComment).toHaveBeenCalledOnce();
    expect(result).toEqual({ status: 'success', findingCount: 1 });
  });

  it('does NOT post inline comments when eventType is PUSH', async () => {
    mockRepoFindUnique.mockResolvedValueOnce(fullRepoWithVault);
    mockFetchDiff.mockResolvedValueOnce('diff body');
    mockAnalyzeCode.mockResolvedValueOnce([
      { filePath: 'a', lineNumber: 1, agentType: 'PERFORMANCE', issue: 'i', suggestion: 's', priority: 'LOW' },
    ]);

    await capturedHandler.fn!(makeJobPayload({ eventType: 'PUSH' }));

    expect(mockCreateReviewComment).not.toHaveBeenCalled();
  });

  it('does NOT post comments when there are zero findings (even on PR)', async () => {
    mockRepoFindUnique.mockResolvedValueOnce(fullRepoWithVault);
    mockFetchDiff.mockResolvedValueOnce('diff body');
    mockAnalyzeCode.mockResolvedValueOnce([]);

    await capturedHandler.fn!(makeJobPayload());

    expect(mockCreateReviewComment).not.toHaveBeenCalled();
  });

  it('surfaces inline comment failures instead of silently claiming success', async () => {
    mockRepoFindUnique.mockResolvedValueOnce(fullRepoWithVault);
    mockFetchDiff.mockResolvedValueOnce('diff body that is long enough');
    mockAnalyzeCode.mockResolvedValueOnce([
      { filePath: 'a.ts', lineNumber: 999999, agentType: 'SECURITY', issue: 'i', suggestion: 's', priority: 'HIGH' },
    ]);
    // GitHub rejects the comment because the line is not in the diff.
    mockCreateReviewComment.mockResolvedValueOnce({
      ok: false,
      error: 'Unprocessable Entity: line invalid',
    });

    const result = await capturedHandler.fn!(makeJobPayload());

    // The analysis itself still succeeded...
    expect(result).toEqual({ status: 'success', findingCount: 1 });

    // ...but the delivery failure must be recorded, not swallowed.
    const resultsPayload = mockJobUpdate.mock.calls
      .map((c: any[]) => c[0]?.data?.results)
      .filter(Boolean)
      .pop();
    expect(resultsPayload.commentFailures).toEqual([
      'a.ts:999999 — Unprocessable Entity: line invalid',
    ]);
    expect(resultsPayload.summaryPosted).toBe(true);

    // And the user must be told via the socket.
    const messages = mockEmitStatus.mock.calls.map((c) => String(c[2]));
    expect(messages.some((m: string) => m.includes('could not be placed inline'))).toBe(true);
  });

  it('records no commentFailures when every inline comment lands', async () => {
    mockRepoFindUnique.mockResolvedValueOnce(fullRepoWithVault);
    mockFetchDiff.mockResolvedValueOnce('diff body that is long enough');
    mockAnalyzeCode.mockResolvedValueOnce([
      { filePath: 'a.ts', lineNumber: 1, agentType: 'SECURITY', issue: 'i', suggestion: 's', priority: 'HIGH' },
    ]);
    mockCreateReviewComment.mockResolvedValueOnce({ ok: true });

    await capturedHandler.fn!(makeJobPayload());

    // No delivery-problem update should have been written.
    const resultsPayloads = mockJobUpdate.mock.calls
      .map((c: any[]) => c[0]?.data?.results)
      .filter(Boolean);
    expect(resultsPayloads.some((r: any) => 'commentFailures' in r)).toBe(false);
  });

  it('sorts findings most severe first before posting', async () => {
    mockRepoFindUnique.mockResolvedValueOnce(fullRepoWithVault);
    mockFetchDiff.mockResolvedValueOnce('diff body that is long enough');
    mockAnalyzeCode.mockResolvedValueOnce([
      { filePath: 'c.ts', lineNumber: 1, agentType: 'BUG', issue: 'i', suggestion: 's', priority: 'LOW' },
      { filePath: 'a.ts', lineNumber: 1, agentType: 'SECURITY', issue: 'i', suggestion: 's', priority: 'CRITICAL' },
      { filePath: 'b.ts', lineNumber: 1, agentType: 'BUG', issue: 'i', suggestion: 's', priority: 'HIGH' },
    ]);
    mockCreateReviewComment.mockResolvedValue({ ok: true });

    await capturedHandler.fn!(makeJobPayload());

    const order = mockCreateReviewComment.mock.calls.map((c: any[]) => c[4]);
    expect(order).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('short-circuits as COMPLETED when the diff is empty (no AI call)', async () => {
    mockRepoFindUnique.mockResolvedValueOnce(fullRepoWithVault);
    mockFetchDiff.mockResolvedValueOnce('');

    await capturedHandler.fn!(makeJobPayload());

    expect(mockAnalyzeCode).not.toHaveBeenCalled();
    expect(mockJobUpdate).toHaveBeenLastCalledWith({
      where: { id: 'job-1' },
      data: { status: 'COMPLETED' },
    });
  });

  it('emits live status updates throughout the run', async () => {
    mockRepoFindUnique.mockResolvedValueOnce(fullRepoWithVault);
    // Diff must be > 5 chars or the worker short-circuits before the COMPLETED emit.
    mockFetchDiff.mockResolvedValueOnce('diff --git body');
    mockAnalyzeCode.mockResolvedValueOnce([]);

    await capturedHandler.fn!(makeJobPayload());

    expect(mockEmitStatus).toHaveBeenCalled();
    // Every emit must target the job owner so other users never see it.
    for (const call of mockEmitStatus.mock.calls) {
      expect(call[0]).toBe('u-owner');
    }
    const lastCall = mockEmitStatus.mock.calls.at(-1);
    expect(lastCall![3]).toBe('COMPLETED');
  });
});

describe('analysis worker — failure paths', () => {
  it('marks the job SKIPPED and stops retrying when the repo has no vault', async () => {
    mockRepoFindUnique.mockResolvedValueOnce({ user: { vault: null } });

    // A missing API key cannot be fixed by retrying, so the job must surface as
    // an UnrecoverableError rather than burning all three attempts.
    await expect(capturedHandler.fn!(makeJobPayload())).rejects.toThrow(
      /No AI API key found in your vault/,
    );

    expect(mockJobUpdate).toHaveBeenLastCalledWith({
      where: { id: 'job-1' },
      data: {
        status: 'SKIPPED',
        results: {
          reason: 'missing-api-key',
          error: expect.stringContaining('No AI API key found'),
        },
      },
    });

    const statuses = mockEmitStatus.mock.calls.map((c) => c[3]);
    expect(statuses).toContain('SKIPPED');
    expect(statuses).not.toContain('FAILED');
  });

  it('surfaces a missing vault as unrecoverable so BullMQ does not retry', async () => {
    mockRepoFindUnique.mockResolvedValueOnce({ user: { vault: null } });

    const err = await capturedHandler
      .fn!(makeJobPayload())
      .then(() => null)
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('UnrecoverableError');
  });

  it('marks the job SKIPPED when the repo itself is missing', async () => {
    // A deleted repo is as permanent as a missing API key — retrying cannot
    // bring it back, so this shares the unrecoverable path.
    mockRepoFindUnique.mockResolvedValueOnce(null);

    await expect(capturedHandler.fn!(makeJobPayload())).rejects.toThrow();

    expect(mockJobUpdate).toHaveBeenLastCalledWith({
      where: { id: 'job-1' },
      data: {
        status: 'SKIPPED',
        results: {
          reason: 'missing-api-key',
          error: expect.any(String),
        },
      },
    });
  });

  it('marks the job FAILED when decryption blows up (e.g., key rotated)', async () => {
    mockRepoFindUnique.mockResolvedValueOnce(fullRepoWithVault);
    mockDecrypt.mockImplementationOnce(() => {
      throw new Error('Decryption failure - key may be compromised');
    });

    await expect(capturedHandler.fn!(makeJobPayload())).rejects.toThrow(/Decryption failure/);

    // Transient: the vault/key may still be fixed, so this stays FAILED and retries.
    expect(mockJobUpdate).toHaveBeenLastCalledWith({
      where: { id: 'job-1' },
      data: { status: 'FAILED', results: { error: expect.any(String) } },
    });
  });

  it('marks the job FAILED when the AI provider throws', async () => {
    mockRepoFindUnique.mockResolvedValueOnce(fullRepoWithVault);
    mockFetchDiff.mockResolvedValueOnce('diff body that is long enough');
    mockAnalyzeCode.mockRejectedValueOnce(new Error('AI provider died'));

    await expect(capturedHandler.fn!(makeJobPayload())).rejects.toThrow(/AI provider died/);

    expect(mockJobUpdate).toHaveBeenLastCalledWith({
      where: { id: 'job-1' },
      data: { status: 'FAILED', results: { error: expect.any(String) } },
    });
  });

  it('marks the job FAILED when the diff fetch fails', async () => {
    mockRepoFindUnique.mockResolvedValueOnce(fullRepoWithVault);
    mockFetchDiff.mockRejectedValueOnce(new Error('Failed to extract diff'));

    await expect(capturedHandler.fn!(makeJobPayload())).rejects.toThrow();
    expect(mockJobUpdate).toHaveBeenLastCalledWith({
      where: { id: 'job-1' },
      data: { status: 'FAILED', results: { error: expect.any(String) } },
    });
  });

  it('re-throws on failure so BullMQ retries are triggered (does NOT swallow)', async () => {
    mockRepoFindUnique.mockRejectedValueOnce(new Error('DB connection lost'));

    // The handler MUST throw — otherwise BullMQ won't retry the job.
    await expect(capturedHandler.fn!(makeJobPayload())).rejects.toThrow(/DB connection lost/);
  });
});
