import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/historical/occurrence.service', async importOriginal => ({
  ...await importOriginal<typeof import('../services/historical/occurrence.service')>(),
  recordJobFindings: vi.fn(async (jobId: string, _repositoryId: string, _findings: unknown, results: unknown) => {
    await mockJobUpdate({ where: { id: jobId }, data: { status: 'COMPLETED', results } });
  }),
}));
vi.mock('../services/historical/review-memory.service', () => ({ retrieveHistoricalMemory: vi.fn() }));
vi.mock('../services/feedback-loop/adaptation.service', async importOriginal => ({
  ...await importOriginal<typeof import('../services/feedback-loop/adaptation.service')>(), retrieveFeedbackAdaptation: vi.fn(),
}));

/**
 * The worker module does `new Worker(QUEUE_NAME, handler, opts)` at import time.
 * To test the handler in isolation we mock the bullmq Worker class, capture the
 * handler that the source code passes in, and then invoke it directly with
 * fake job payloads.
 */
const { capturedHandler, WorkerMock, mockJobUpdate, mockJobFindUnique, mockRepoFindUnique, mockRuleFindMany, mockRuleCheckCreateMany, mockSecurityCheckCreateMany, mockDecrypt, mockFetchDiff, mockCreateReviewComment, mockGetProvider, mockAnalyzeCode, mockEmitStatus, GitHubServiceCtor } = vi.hoisted(() => {
  const capturedHandler: { fn?: (job: any) => Promise<any> } = {};

  const WorkerMock = vi.fn(function (this: any, _name: string, handler: any) {
    capturedHandler.fn = handler;
    this.on = vi.fn();
  });

  const mockJobUpdate = vi.fn();
  // Read by advanceReview() to decide whether a transition moves the job forward.
  const mockJobFindUnique = vi.fn();
  const mockRepoFindUnique = vi.fn();
  // DB-stored engineering rules: fetched before analysis, results written after.
  const mockRuleFindMany = vi.fn();
  const mockRuleCheckCreateMany = vi.fn();
  // Deterministic security probes: one PASS/FAIL row per probe per job.
  const mockSecurityCheckCreateMany = vi.fn();
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
    mockJobFindUnique,
    mockRepoFindUnique,
    mockRuleFindMany,
    mockRuleCheckCreateMany,
    mockSecurityCheckCreateMany,
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
analysisQueue: { add: vi.fn() },
}));

vi.mock('../config/prisma', () => ({
  default: {
    analysisJob: { update: mockJobUpdate, findUnique: mockJobFindUnique },
    repository: { findUnique: mockRepoFindUnique },
    repositoryRule: { findMany: mockRuleFindMany },
    ruleCheck: { createMany: mockRuleCheckCreateMany },
    securityCheck: { createMany: mockSecurityCheckCreateMany },
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
import { REVIEW_TIMEOUT_MS } from '../utils/constants';

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
  // Default: no DB-stored rules, so reviews behave exactly as before they
  // existed unless a test opts in.
  mockRuleFindMany.mockResolvedValue([]);
  mockRuleCheckCreateMany.mockResolvedValue({ count: 0 });
  mockSecurityCheckCreateMany.mockResolvedValue({ count: 0 });
  // Default: the job has not entered the pipeline, so every advanceReview()
  // transition is a forward move and gets persisted.
  mockJobFindUnique.mockResolvedValue({ status: 'QUEUED' });
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
  it('supplies feedback statistics separately and persists adaptation without changing findings or risk', async () => {
    const { retrieveFeedbackAdaptation } = await import('../services/feedback-loop/adaptation.service');
    const { generateFingerprint } = await import('../services/historical/fingerprint.service');
    const { assessRisk } = await import('../services/security/risk-engine');
    const advisory: any = { filePath: 'src/a.ts', lineNumber: 10, agentType: 'STYLE', priority: 'LOW', issue: 'Naming mismatch', suggestion: 'Use team conventions' };
    const fingerprint = generateFingerprint(advisory);
    vi.mocked(retrieveFeedbackAdaptation).mockResolvedValueOnce({ enabled: true, partial: false, revision: 1, scannedJobs: 5,
      policy: { version: 'feedback_v1' } as any, suppliedFingerprints: [fingerprint], serializedContext: 'UNTRUSTED_FEEDBACK_STATS',
      recommendations: [{ fingerprint, reviewedPrs: 5, rejectedPrs: 4, reason: 'STYLE_PREFERENCE', reasons: { STYLE_PREFERENCE: 4 },
        recommendation: 'Propose a guideline', expiresAt: new Date(Date.now() + 86400000).toISOString(), summary: 'Naming' }],
    });
    mockRepoFindUnique.mockResolvedValueOnce(fullRepoWithVault);
    mockFetchDiff.mockResolvedValueOnce('diff --git a/foo b/foo\n+ x'); mockAnalyzeCode.mockResolvedValueOnce([advisory]);
    await capturedHandler.fn!(makeJobPayload());
    expect(mockAnalyzeCode.mock.calls[0][1]).not.toContain('UNTRUSTED_FEEDBACK_STATS');
    expect(mockAnalyzeCode.mock.calls[0][3]).toMatchObject({ feedbackContext: 'UNTRUSTED_FEEDBACK_STATS' });
    const result = mockJobUpdate.mock.calls.at(-1)![0].data.results;
    expect(result.suggestions).toEqual(assessRisk([advisory]).findings);
    expect(result.risk).toEqual(assessRisk([advisory]).report);
    expect(result.feedbackAdaptation.entries).toHaveLength(1);
    expect(result.feedbackAdaptation.suppliedFingerprints).toEqual([fingerprint]);
  });
  it('keeps historical context out of binding rules and persists accurate attribution', async () => {
    const { retrieveHistoricalMemory } = await import('../services/historical/review-memory.service');
    vi.mocked(retrieveHistoricalMemory).mockResolvedValueOnce({ version: 1, algorithmVersion: 'fp_v2',
      patterns: [{ patternId: 'p1' } as any], suppliedPatternIds: ['p1'], truncated: true,
      serializedContext: 'UNTRUSTED_HISTORICAL_JSON',
    });
    mockRepoFindUnique.mockResolvedValueOnce(fullRepoWithVault);
    mockFetchDiff.mockResolvedValueOnce('diff --git body');
    mockAnalyzeCode.mockResolvedValueOnce([]);
    await capturedHandler.fn!(makeJobPayload());
    expect(mockAnalyzeCode.mock.calls[0][1]).not.toContain('UNTRUSTED_HISTORICAL_JSON');
    expect(mockAnalyzeCode.mock.calls[0][3]).toMatchObject({ historicalContext: 'UNTRUSTED_HISTORICAL_JSON' });
    expect(mockJobUpdate.mock.calls.at(-1)![0].data.results.historicalMemory).toEqual({
      version: 1, algorithmVersion: 'fp_v2', suppliedPatternIds: ['p1'], patternCount: 1, truncated: true,
    });
  });
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

    // The pipeline walks FETCHING -> ANALYZING -> GENERATING -> POSTING, and
    // only reaches COMPLETED once delivery has finished.
    const phases = mockJobUpdate.mock.calls
      .map(([arg]: any[]) => arg?.data?.status)
      .filter(Boolean);
    expect(phases[0]).toBe('FETCHING');
    expect(phases).toContain('ANALYZING');
    expect(phases).toContain('GENERATING');
    expect(phases).toContain('POSTING');
    expect(phases[phases.length - 1]).toBe('COMPLETED');
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

    // Every comment landed, so the final results payload records an empty
    // failure list rather than omitting it.
    const finalResults = mockJobUpdate.mock.calls
      .map((c: any[]) => c[0]?.data?.results)
      .filter(Boolean)
      .pop();
    expect(finalResults.commentFailures).toEqual([]);
    expect(finalResults.summaryPosted).toBe(true);
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
      data: { status: 'COMPLETED', results: { suggestions: [] } },
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

describe('analysis worker — cancellation and timeout', () => {
  // Before this, CANCELLED and TIMEOUT were enum values nothing could ever
  // produce: a hung review held its worker slot forever and a cancelled review
  // kept posting comments. These guard both exits.
  const reviewWithFindings = () => {
    mockRepoFindUnique.mockResolvedValueOnce(fullRepoWithVault);
    mockFetchDiff.mockResolvedValueOnce('diff --git a/foo b/foo\n+ x');
    mockAnalyzeCode.mockResolvedValueOnce([
      { filePath: 'foo.ts', lineNumber: 10, agentType: 'SECURITY', issue: 'x', suggestion: 'y', priority: 'HIGH' },
    ]);
  };

  it('abandons the attempt when the review was cancelled while awaiting the model', async () => {
    reviewWithFindings();
    // The cancellation lands after FETCHING is written but before the AI call
    // returns — exactly the window where a naive worker would carry on.
    mockJobFindUnique
      .mockResolvedValueOnce({ status: 'QUEUED' })
      .mockResolvedValueOnce({ status: 'CANCELLED' });

    await expect(capturedHandler.fn!(makeJobPayload())).rejects.toThrow();

    expect(mockCreateReviewComment).not.toHaveBeenCalled();
  });

  it('does not overwrite CANCELLED with FAILED', async () => {
    reviewWithFindings();
    mockJobFindUnique
      .mockResolvedValueOnce({ status: 'QUEUED' })
      .mockResolvedValueOnce({ status: 'CANCELLED' });

    await expect(capturedHandler.fn!(makeJobPayload())).rejects.toThrow();

    const statuses = mockJobUpdate.mock.calls.map((c: any[]) => c[0]?.data?.status);
    expect(statuses).not.toContain('FAILED');
    expect(statuses).not.toContain('COMPLETED');
  });

  it('does not overwrite TIMEOUT with FAILED', async () => {
    reviewWithFindings();
    mockJobFindUnique
      .mockResolvedValueOnce({ status: 'QUEUED' })
      .mockResolvedValueOnce({ status: 'TIMEOUT' });

    await expect(capturedHandler.fn!(makeJobPayload())).rejects.toThrow();

    const statuses = mockJobUpdate.mock.calls.map((c: any[]) => c[0]?.data?.status);
    expect(statuses).not.toContain('FAILED');
    expect(statuses).not.toContain('COMPLETED');
  });

  it('still completes normally when nothing superseded the review', async () => {
    // Guard against the guard over-triggering on the happy path.
    reviewWithFindings();
    mockCreateReviewComment.mockResolvedValueOnce({ ok: true });

    const result = await capturedHandler.fn!(makeJobPayload());

    expect(result).toEqual({ status: 'success', findingCount: 1 });
    const statuses = mockJobUpdate.mock.calls.map((c: any[]) => c[0]?.data?.status);
    expect(statuses[statuses.length - 1]).toBe('COMPLETED');
  });

  it('does not post comments when the review was cancelled before analysis finished', async () => {
    reviewWithFindings();
    mockJobFindUnique
      .mockResolvedValueOnce({ status: 'QUEUED' })
      .mockResolvedValueOnce({ status: 'CANCELLED' });

    await expect(capturedHandler.fn!(makeJobPayload())).rejects.toThrow();

    // The whole point of the guard: nothing reaches the PR.
    expect(mockCreateReviewComment).not.toHaveBeenCalled();
  });

  it('leaves the job CANCELLED rather than SKIPPED when it was cancelled mid-flight', async () => {
    reviewWithFindings();
    mockJobFindUnique
      .mockResolvedValueOnce({ status: 'QUEUED' })
      .mockResolvedValueOnce({ status: 'TIMEOUT' });

    await expect(capturedHandler.fn!(makeJobPayload())).rejects.toThrow();

    const statuses = mockJobUpdate.mock.calls.map((c: any[]) => c[0]?.data?.status);
    expect(statuses).not.toContain('SKIPPED');
  });

  it('passes an abort signal to the provider so a stale model call can be cancelled', async () => {
    reviewWithFindings();

    await capturedHandler.fn!(makeJobPayload());

    const options = mockAnalyzeCode.mock.calls[0][3];
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('releases the worker slot when the model call hangs past the deadline', async () => {
    // Regression: the timeout used to only rewrite the job status. A provider
    // request that never settled kept the await pending forever, so the worker
    // slot was never freed and eventually every slot was consumed.
    vi.useFakeTimers();
    try {
      mockRepoFindUnique.mockResolvedValueOnce(fullRepoWithVault);
      mockFetchDiff.mockResolvedValueOnce('diff --git a/foo b/foo\n+ x');
      mockAnalyzeCode.mockReturnValueOnce(new Promise<never>(() => {}));

      const run = capturedHandler.fn!(makeJobPayload());
      // Attach the rejection handler before advancing: the deadline fires while
      // the timers flush, and an unhandled rejection would otherwise be reported.
      const assertion = expect(run).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(REVIEW_TIMEOUT_MS + 1);

      await assertion;

      const statuses = mockJobUpdate.mock.calls.map((c: any[]) => c[0]?.data?.status);
      expect(statuses).toContain('TIMEOUT');
      expect(mockCreateReviewComment).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('analysis worker — repository rules', () => {
  const deterministicRule = {
    id: 'rule-1',
    name: 'No eval',
    description: 'eval() is forbidden anywhere in application code',
    guideline: null,
    pattern: 'eval\\(',
    severity: 'HIGH',
    category: 'SECURITY',
    enforcement: 'DETERMINISTIC',
    enabled: true,
  };

  const llmRule = {
    id: 'rule-2',
    name: 'Changelog entries',
    description: null,
    guideline: 'Every user-facing change must add a CHANGELOG entry.',
    pattern: null,
    severity: 'LOW',
    category: 'MAINTAINABILITY',
    enforcement: 'LLM',
    enabled: true,
  };

  // A real unified diff: the added line sits at new-file line 2.
  const diffWithEval =
    'diff --git a/src/app.ts b/src/app.ts\n' +
    '--- a/src/app.ts\n' +
    '+++ b/src/app.ts\n' +
    '@@ -1,3 +1,4 @@\n' +
    ' const a = 1;\n' +
    '+eval(userInput);\n' +
    ' console.log(a);';

  it('posts a deterministic rule violation as an inline comment even when the model reports nothing', async () => {
    mockRepoFindUnique.mockResolvedValueOnce(fullRepoWithVault);
    mockRuleFindMany.mockResolvedValueOnce([deterministicRule]);
    mockFetchDiff.mockResolvedValueOnce(diffWithEval);
    mockAnalyzeCode.mockResolvedValueOnce([]);
    mockCreateReviewComment.mockResolvedValueOnce({ ok: true });

    const result = await capturedHandler.fn!(makeJobPayload());

    expect(result).toEqual({ status: 'success', findingCount: 1 });
    expect(mockCreateReviewComment).toHaveBeenCalledOnce();
    const [owner, repo, prNum, sha, path, line] = mockCreateReviewComment.mock.calls[0];
    expect([owner, repo, prNum, sha]).toEqual(['octo', 'cat', 42, 'head-sha']);
    expect(path).toBe('src/app.ts');
    expect(line).toBe(2);
  });

  it('records a per-rule FAIL with the violation count and stores it on the job', async () => {
    mockRepoFindUnique.mockResolvedValueOnce(fullRepoWithVault);
    mockRuleFindMany.mockResolvedValueOnce([deterministicRule, llmRule]);
    mockFetchDiff.mockResolvedValueOnce(diffWithEval);
    mockAnalyzeCode.mockResolvedValueOnce([]);
    mockCreateReviewComment.mockResolvedValueOnce({ ok: true });

    await capturedHandler.fn!(makeJobPayload());

    expect(mockRuleCheckCreateMany).toHaveBeenCalledTimes(1);
    const payload = mockRuleCheckCreateMany.mock.calls[0][0];
    expect(payload.skipDuplicates).toBe(true);
    expect(payload.data).toEqual([
      { analysisJobId: 'job-1', ruleId: 'rule-1', ruleName: 'No eval', status: 'FAIL', violationCount: 1 },
      // LLM-only rules cannot be judged deterministically — recorded as
      // SKIPPED rather than invented as PASS or FAIL.
      { analysisJobId: 'job-1', ruleId: 'rule-2', ruleName: 'Changelog entries', status: 'SKIPPED', violationCount: 0 },
    ]);

    const finalResults = mockJobUpdate.mock.calls
      .map((c: any[]) => c[0]?.data?.results)
      .filter(Boolean)
      .pop();
    expect(finalResults.ruleChecks).toHaveLength(2);
    expect(finalResults.ruleChecks[0]).toMatchObject({ status: 'FAIL', violationCount: 1 });
  });

  it('records PASS when a deterministic rule matches nothing in the diff', async () => {
    mockRepoFindUnique.mockResolvedValueOnce(fullRepoWithVault);
    mockRuleFindMany.mockResolvedValueOnce([deterministicRule]);
    mockFetchDiff.mockResolvedValueOnce('diff body that is long enough');
    mockAnalyzeCode.mockResolvedValueOnce([]);

    await capturedHandler.fn!(makeJobPayload());

    const payload = mockRuleCheckCreateMany.mock.calls[0][0];
    expect(payload.data).toEqual([
      { analysisJobId: 'job-1', ruleId: 'rule-1', ruleName: 'No eval', status: 'PASS', violationCount: 0 },
    ]);
    // Nothing matched, so no comment is placed for this rule.
    expect(mockCreateReviewComment).not.toHaveBeenCalled();
  });

  it('merges DB rule guidelines into the prompt alongside .aipr.yml guidelines', async () => {
    mockRepoFindUnique.mockResolvedValueOnce(fullRepoWithVault);
    mockRuleFindMany.mockResolvedValueOnce([deterministicRule, llmRule]);
    mockFetchDiff.mockResolvedValueOnce(diffWithEval);
    mockAnalyzeCode.mockResolvedValueOnce([]);
    mockCreateReviewComment.mockResolvedValueOnce({ ok: true });

    await capturedHandler.fn!(makeJobPayload());

    const guidelines = mockAnalyzeCode.mock.calls[0][1];
    // The deterministic rule's pattern is regex soup, not prompt wording —
    // only the LLM-enforced rule reaches the model.
    expect(guidelines).toEqual(['[Changelog entries] Every user-facing change must add a CHANGELOG entry.']);
  });

  it('does not filter deterministic violations by min_severity', async () => {
    mockRepoFindUnique.mockResolvedValueOnce(fullRepoWithVault);
    // The model's finding sits below the default threshold; the rule's INFO
    // violation must still survive, because the user asked for that rule
    // explicitly.
    mockRuleFindMany.mockResolvedValueOnce([{ ...deterministicRule, severity: 'INFO' }]);
    mockFetchDiff.mockResolvedValueOnce(diffWithEval);
    mockAnalyzeCode.mockResolvedValueOnce([
      { filePath: 'src/app.ts', lineNumber: 1, agentType: 'STYLE', issue: 'i', suggestion: 's', priority: 'INFO' },
    ]);
    mockCreateReviewComment.mockResolvedValueOnce({ ok: true });

    const result = await capturedHandler.fn!(makeJobPayload());

    expect(result.findingCount).toBe(1);
    expect(mockCreateReviewComment).toHaveBeenCalledOnce();
    expect(mockCreateReviewComment.mock.calls[0][4]).toBe('src/app.ts');
    expect(mockCreateReviewComment.mock.calls[0][5]).toBe(2);
  });
});

describe('analysis worker — security probes', () => {
  // The added line sits at new-file line 2 with "SELECT ... " + concatenation:
  // an unambiguous SQL-injection pattern the SAST probe must catch.
  const diffWithSqlConcat =
    'diff --git a/src/db.ts b/src/db.ts\n' +
    '--- a/src/db.ts\n' +
    '+++ b/src/db.ts\n' +
    '@@ -1,3 +1,4 @@\n' +
    ' const a = 1;\n' +
    '+db.query("SELECT * FROM users WHERE id = " + req.params.id);\n' +
    ' console.log(a);';

  // An hardcoded OpenAI key on the added line. Deliberately obvious so the
  // secrets probe must flag it and the redaction rule must mask it.
  const diffWithSecret =
    'diff --git a/src/config.ts b/src/config.ts\n' +
    '--- a/src/config.ts\n' +
    '+++ b/src/config.ts\n' +
    '@@ -1,3 +1,4 @@\n' +
    ' const a = 1;\n' +
    '+const OPENAI_KEY = "sk-abcdefghijklmnopqrstuvwxyz123456";\n' +
    ' console.log(a);';

  it('posts a deterministic SAST finding inline even when the model reports nothing', async () => {
    mockRepoFindUnique.mockResolvedValueOnce(fullRepoWithVault);
    mockFetchDiff.mockResolvedValueOnce(diffWithSqlConcat);
    mockAnalyzeCode.mockResolvedValueOnce([]);
    mockCreateReviewComment.mockResolvedValueOnce({ ok: true });

    const result = await capturedHandler.fn!(makeJobPayload());

    expect(result.findingCount).toBe(1);
    expect(mockCreateReviewComment).toHaveBeenCalledOnce();
    const [owner, repo, prNum, sha, path, line] = mockCreateReviewComment.mock.calls[0];
    expect([owner, repo, prNum, sha]).toEqual(['octo', 'cat', 42, 'head-sha']);
    expect(path).toBe('src/db.ts');
    expect(line).toBe(2);
  });

  it('writes one PASS/FAIL security check per probe and stores the risk report', async () => {
    mockRepoFindUnique.mockResolvedValueOnce(fullRepoWithVault);
    mockFetchDiff.mockResolvedValueOnce(diffWithSqlConcat);
    mockAnalyzeCode.mockResolvedValueOnce([]);
    mockCreateReviewComment.mockResolvedValueOnce({ ok: true });

    await capturedHandler.fn!(makeJobPayload());

    const payload = mockSecurityCheckCreateMany.mock.calls[0][0];
    expect(payload.skipDuplicates).toBe(true);
    expect(payload.data).toHaveLength(3);
    const sast = payload.data.find((c: any) => c.probe === 'SAST');
    const secrets = payload.data.find((c: any) => c.probe === 'SECRETS');
    const deps = payload.data.find((c: any) => c.probe === 'DEPENDENCIES');
    expect(sast).toMatchObject({ analysisJobId: 'job-1', status: 'FAIL', findingCount: 1 });
    expect(secrets).toMatchObject({ status: 'PASS', findingCount: 0 });
    expect(deps).toMatchObject({ status: 'SKIPPED', findingCount: 0 });

    const finalResults = mockJobUpdate.mock.calls
      .map((c: any[]) => c[0]?.data?.results)
      .filter(Boolean)
      .pop();

    // A CRITICAL SAST finding is blocking on its own.
    expect(finalResults.risk).toMatchObject({
      score: 30,
      verdict: 'BLOCK',
      blockingCount: 1,
      securityFindingCount: 1,
    });
    expect(finalResults.securityChecks).toHaveLength(3);

    // The socket must announce both the probe tally and the verdict.
    const messages = mockEmitStatus.mock.calls.map((c) => String(c[2]));
    expect(messages.some((m) => m.includes('Security probes'))).toBe(true);
    expect(messages.some((m) => m.includes('Risk engine'))).toBe(true);
  });

  it('redacts hardcoded secrets in the posted finding and blocks the review', async () => {
    mockRepoFindUnique.mockResolvedValueOnce(fullRepoWithVault);
    mockFetchDiff.mockResolvedValueOnce(diffWithSecret);
    mockAnalyzeCode.mockResolvedValueOnce([]);
    mockCreateReviewComment.mockResolvedValueOnce({ ok: true });

    const result = await capturedHandler.fn!(makeJobPayload());

    expect(mockCreateReviewComment).toHaveBeenCalledOnce();
    const [, , , , , , comment] = mockCreateReviewComment.mock.calls[0];
    expect(comment).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(comment).toContain('redacted');
    expect(comment).toContain('••••');

    const finalResults = mockJobUpdate.mock.calls
      .map((c: any[]) => c[0]?.data?.results)
      .filter(Boolean)
      .pop();
    expect(finalResults.risk.verdict).toBe('BLOCK');
    expect(finalResults.risk.reasons.some((r: string) => r.includes('credential'))).toBe(true);
    expect(result.findingCount).toBe(1);
  });

  it('does not filter deterministic security findings by min_severity', async () => {
    // The model reports nothing. The SAST CRITICAL finding must still be
    // posted and scored (CRITICAL weight = 30) even though it is deterministic —
    // deterministic controls are never optional behind a repo-wide threshold.
    mockRepoFindUnique.mockResolvedValueOnce(fullRepoWithVault);
    mockFetchDiff.mockResolvedValueOnce(diffWithSqlConcat);
    mockAnalyzeCode.mockResolvedValueOnce([]);
    mockCreateReviewComment.mockResolvedValueOnce({ ok: true });

    const result = await capturedHandler.fn!(makeJobPayload());
    expect(result.findingCount).toBe(1);
    expect(mockCreateReviewComment).toHaveBeenCalledOnce();

    const finalResults = mockJobUpdate.mock.calls
      .map((c: any[]) => c[0]?.data?.results)
      .filter(Boolean)
      .pop();
    expect(finalResults.risk.score).toBe(30); // CRITICAL weight confirms severity survived
  });
});

describe('analysis worker — test-gap analysis', () => {
  const diffWithSourceFile =
    'diff --git a/src/db.ts b/src/db.ts\n' +
    '--- a/src/db.ts\n' +
    '+++ b/src/db.ts\n' +
    '@@ -1,3 +1,4 @@\n' +
    ' const a = 1;\n' +
    '+export function load(id) { return db.get(id); }\n' +
    ' console.log(a);';

  it('persists a test-gap report when the provider supports analysis', async () => {
    mockRepoFindUnique.mockResolvedValueOnce(fullRepoWithVault);
    mockFetchDiff.mockResolvedValueOnce(diffWithSourceFile);
    mockAnalyzeCode.mockResolvedValueOnce([]);
    const analyzeTestGaps = vi.fn().mockResolvedValueOnce([
      {
        filePath: 'src/db.ts',
        lineNumber: 1,
        scenario: 'load() with an undefined id',
        expected: 'rejects',
        confidence: 'HIGH',
      },
    ]);
    mockGetProvider.mockReturnValueOnce({ analyzeCode: mockAnalyzeCode, analyzeTestGaps });

    await capturedHandler.fn!(makeJobPayload());

    expect(analyzeTestGaps).toHaveBeenCalledOnce();
    const input = analyzeTestGaps.mock.calls[0][0];
    // Only the changed source is proposed as an analysis target.
    expect(input.changedSources).toEqual(['src/db.ts']);

    const finalResults = mockJobUpdate.mock.calls
      .map((c: any[]) => c[0]?.data?.results)
      .filter(Boolean)
      .pop();
    expect(finalResults.testGaps).toMatchObject({ analyzed: true });
    expect(finalResults.testGaps.scenarios).toHaveLength(1);
    expect(finalResults.behavioral.scenarios[0]).toMatchObject({ stage: 'GENERATED', status: 'NOT_RUN' });
    expect(finalResults.riskV2).toMatchObject({ version: 2, direction: 'HIGHER_IS_RISKIER', enforcement: 'ADVISORY' });
    expect(finalResults.riskV2.coverage.behavioral.executed).toBe(0);
    // Generating a scenario does not become an executed test or a legacy finding.
    expect(finalResults.suggestions).toEqual([]);
    expect(finalResults.risk.score).toBe(0);

    const messages = mockEmitStatus.mock.calls.map((c) => String(c[2]));
    expect(messages.some((m) => m.includes('missing test scenario'))).toBe(true);
  });

  it('omits test-gap data when the provider cannot analyze test gaps', async () => {
    // The default mock provider exposes only analyzeCode; the step must be a
    // silent no-op rather than crashing the review.
    mockRepoFindUnique.mockResolvedValueOnce(fullRepoWithVault);
    mockFetchDiff.mockResolvedValueOnce(diffWithSourceFile);
    mockAnalyzeCode.mockResolvedValueOnce([]);

    const result = await capturedHandler.fn!(makeJobPayload());
    expect(result.status).toBe('success');

    const finalResults = mockJobUpdate.mock.calls
      .map((c: any[]) => c[0]?.data?.results)
      .filter(Boolean)
      .pop();
    expect(finalResults.testGaps).toBeNull();
  });
});
