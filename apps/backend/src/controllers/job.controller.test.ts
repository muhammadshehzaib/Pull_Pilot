import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockJobFindMany, mockJobCount, mockJobFindFirst, mockJobUpdate, mockQueueRemove, mockEmitStatus } = vi.hoisted(() => ({
  mockJobFindMany: vi.fn(),
  mockJobCount: vi.fn(),
  mockJobFindFirst: vi.fn(),
  mockJobUpdate: vi.fn(),
  mockQueueRemove: vi.fn(),
  mockEmitStatus: vi.fn(),
}));

vi.mock('../config/prisma', () => ({
  default: {
    $transaction: async (fn: any) => fn({ $queryRaw: async () => [], analysisJob: { findUnique: async () => ({ status: 'POSTING' }), update: mockJobUpdate } }),
    analysisJob: {
      findMany: mockJobFindMany,
      count: mockJobCount,
      findFirst: mockJobFindFirst,
      update: mockJobUpdate,
    },
  },
}));

vi.mock('../config/queue', () => ({
  analysisQueue: { remove: mockQueueRemove },
}));

vi.mock('../config/socket', () => ({
  SocketService: { emitStatus: mockEmitStatus },
}));

import { JobController, parseJobStatus, normalizeFindingAdaptation } from './job.controller';
import { mockReq, mockRes } from '../test-utils/express-mocks';
import { loadReviewDelivery, reconcileReviewDelivery } from '../services/comment-delivery.service';
import { GitHubAppService } from '../services/github-app.service';

vi.mock('../services/comment-delivery.service', () => ({ loadReviewDelivery: vi.fn(), reconcileReviewDelivery: vi.fn() }));
vi.mock('../services/github-app.service', () => ({ GitHubAppService: { getInstallationService: vi.fn() } }));

const authedReq = (overrides = {}) => {
  const req = mockReq(overrides);
  (req as any).auth = { userId: 'u-1', githubId: 'gh' };
  return req;
};

beforeEach(() => {
  vi.clearAllMocks();
  // The list endpoint counts in parallel with the page query; every test that
  // does not care about totals should still see a sane zero rather than
  // `undefined` flowing into the pagination math.
  mockJobCount.mockResolvedValue(0);
});

describe('JobController.list', () => {
  it('returns the user\'s jobs with findingCount derived from results array', async () => {
    const suggestion = (filePath: string) => ({
      filePath,
      lineNumber: 1,
      issue: 'issue',
      suggestion: 'fix',
      agentType: 'SECURITY',
      priority: 'HIGH',
    });
    mockJobFindMany.mockResolvedValueOnce([
      {
        id: 'j1',
        eventType: 'PULL_REQUEST',
        referenceId: '1',
        status: 'COMPLETED',
        createdAt: new Date(),
        updatedAt: new Date(),
        repository: { id: 'r1', fullName: 'o/r' },
        results: [suggestion('a.ts'), suggestion('b.ts'), suggestion('c.ts')],
      },
    ]);

    const req = authedReq();
    const res = mockRes();

    await JobController.list(req, res);

    const out = res.json.mock.calls[0][0];
    expect(out.jobs[0].findingCount).toBe(3);
    expect(out.jobs[0]).not.toHaveProperty('results'); // lightweight, no full results
  });

  it('ignores malformed entries when counting findings', async () => {
    // extractNormalizedFindings drops anything missing the required shape, so a
    // partially corrupt results blob must not inflate the count.
    mockJobFindMany.mockResolvedValueOnce([
      {
        id: 'j1',
        eventType: 'PULL_REQUEST',
        referenceId: '1',
        status: 'COMPLETED',
        createdAt: new Date(),
        updatedAt: new Date(),
        repository: { id: 'r1', fullName: 'o/r' },
        results: [
          { filePath: 'a.ts', lineNumber: 1, issue: 'i', suggestion: 's' },
          { x: 1 },
          null,
          'garbage',
        ],
      },
    ]);

    const req = authedReq();
    const res = mockRes();

    await JobController.list(req, res);

    expect(res.json.mock.calls[0][0].jobs[0].findingCount).toBe(1);
  });

  it('returns findingCount 0 when results is null/non-array', async () => {
    mockJobFindMany.mockResolvedValueOnce([
      { id: 'j1', eventType: 'PUSH', referenceId: 'x', status: 'QUEUED', createdAt: new Date(), updatedAt: new Date(), repository: { id: 'r', fullName: 'o/r' }, results: null },
      { id: 'j2', eventType: 'PUSH', referenceId: 'y', status: 'FAILED', createdAt: new Date(), updatedAt: new Date(), repository: { id: 'r', fullName: 'o/r' }, results: { not: 'array' } },
    ]);

    const req = authedReq();
    const res = mockRes();

    await JobController.list(req, res);

    const out = res.json.mock.calls[0][0];
    expect(out.jobs[0].findingCount).toBe(0);
    expect(out.jobs[1].findingCount).toBe(0);
  });

  it('clamps absurdly large limit values to the max (100)', async () => {
    mockJobFindMany.mockResolvedValueOnce([]);
    const req = authedReq({ query: { limit: '99999' } });
    const res = mockRes();

    await JobController.list(req, res);

    expect(mockJobFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 }),
    );
  });

  it('clamps negative limit values to a minimum of 1', async () => {
    // Note: limit=0 short-circuits to the default (50) via `parseInt(...) || DEFAULT_LIMIT`.
    // Only truly-negative parses (e.g., "-5") actually exercise the Math.max(.., 1) floor.
    mockJobFindMany.mockResolvedValueOnce([]);
    const req = authedReq({ query: { limit: '-5' } });
    const res = mockRes();

    await JobController.list(req, res);

    expect(mockJobFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 1 }),
    );
  });

  it('falls back to default limit (50) when limit param is unparseable', async () => {
    mockJobFindMany.mockResolvedValueOnce([]);
    const req = authedReq({ query: { limit: 'banana' } });
    const res = mockRes();

    await JobController.list(req, res);

    expect(mockJobFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 }),
    );
  });

  it('applies repositoryId filter when provided', async () => {
    mockJobFindMany.mockResolvedValueOnce([]);
    const req = authedReq({ query: { repositoryId: 'r-42' } });
    const res = mockRes();

    await JobController.list(req, res);

    const arg = mockJobFindMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({ repositoryId: 'r-42' });
  });

  it('always scopes by the auth user (regression guard against IDOR)', async () => {
    mockJobFindMany.mockResolvedValueOnce([]);
    const req = authedReq();
    const res = mockRes();

    await JobController.list(req, res);

    const arg = mockJobFindMany.mock.calls[0][0];
    expect(arg.where.repository).toEqual({ userId: 'u-1' });
  });

  it('filters by referenceId so one PR\'s review history is one query', async () => {
    // The roadmap asks for "every previous review on a PR". Without this the only
    // way to find them was paging the global 50-row list.
    mockJobFindMany.mockResolvedValueOnce([]);
    const req = authedReq({ query: { referenceId: '42' } });
    const res = mockRes();

    await JobController.list(req, res);

    expect(mockJobFindMany.mock.calls[0][0].where).toMatchObject({ referenceId: '42' });
  });

  it('scopes a referenceId filter to the user, not just the PR number', async () => {
    mockJobFindMany.mockResolvedValueOnce([]);
    const req = authedReq({ query: { referenceId: '42' } });
    const res = mockRes();

    await JobController.list(req, res);

    const where = mockJobFindMany.mock.calls[0][0].where;
    expect(where.referenceId).toBe('42');
    expect(where.repository).toEqual({ userId: 'u-1' });
  });

  it('combines referenceId and repositoryId filters', async () => {
    mockJobFindMany.mockResolvedValueOnce([]);
    const req = authedReq({ query: { referenceId: '42', repositoryId: 'r-1' } });
    const res = mockRes();

    await JobController.list(req, res);

    expect(mockJobFindMany.mock.calls[0][0].where).toMatchObject({
      referenceId: '42',
      repositoryId: 'r-1',
    });
  });

  it('applies a valid status filter', async () => {
    mockJobFindMany.mockResolvedValueOnce([]);
    const req = authedReq({ query: { status: 'FAILED' } });
    const res = mockRes();

    await JobController.list(req, res);

    expect(mockJobFindMany.mock.calls[0][0].where).toMatchObject({ status: 'FAILED' });
  });

  it('accepts the new review phases as a status filter', async () => {
    for (const phase of ['FETCHING', 'ANALYZING', 'GENERATING', 'POSTING']) {
      mockJobFindMany.mockResolvedValueOnce([]);
      await JobController.list(authedReq({ query: { status: phase } }), mockRes());
      const where = mockJobFindMany.mock.calls.at(-1)![0].where;
      expect(where, phase).toMatchObject({ status: phase });
    }
  });

  it('ignores an unrecognised status rather than erroring', async () => {
    // The filter must never be able to break the list endpoint.
    mockJobFindMany.mockResolvedValueOnce([]);
    const req = authedReq({ query: { status: 'NOT_A_STATUS' } });
    const res = mockRes();

    await JobController.list(req, res);

    expect(mockJobFindMany.mock.calls[0][0].where).not.toHaveProperty('status');
    expect(res.json).toHaveBeenCalledWith({
      jobs: [],
      pagination: { page: 1, limit: 50, total: 0, totalPages: 1 },
    });
  });

  it('does not add empty-string filters', async () => {
    mockJobFindMany.mockResolvedValueOnce([]);
    const req = authedReq({ query: { referenceId: '', repositoryId: '', status: '' } });
    const res = mockRes();

    await JobController.list(req, res);

    const where = mockJobFindMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('referenceId');
    expect(where).not.toHaveProperty('repositoryId');
    expect(where).not.toHaveProperty('status');
  });
});

describe('JobController.list — pagination', () => {
  it('defaults to page 1 with no skip', async () => {
    mockJobFindMany.mockResolvedValueOnce([]);
    const req = authedReq();
    const res = mockRes();

    await JobController.list(req, res);

    expect(mockJobFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 50 }),
    );
    expect(res.json.mock.calls[0][0].pagination).toEqual({
      page: 1,
      limit: 50,
      total: 0,
      totalPages: 1,
    });
  });

  it('derives skip from page and limit', async () => {
    mockJobFindMany.mockResolvedValueOnce([]);
    mockJobCount.mockResolvedValueOnce(45);
    const req = authedReq({ query: { page: '3', limit: '20' } });
    const res = mockRes();

    await JobController.list(req, res);

    expect(mockJobFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 40, take: 20 }),
    );
    expect(res.json.mock.calls[0][0].pagination).toEqual({
      page: 3,
      limit: 20,
      total: 45,
      totalPages: 3,
    });
  });

  it('clamps a bad page to 1 instead of returning an empty page', async () => {
    for (const bad of ['0', '-5', 'banana']) {
      mockJobFindMany.mockResolvedValueOnce([]);
      const res = mockRes();

      await JobController.list(authedReq({ query: { page: bad } }), res);

      expect(mockJobFindMany.mock.calls.at(-1)![0], bad).toMatchObject({ skip: 0 });
      expect(res.json.mock.calls[0][0].pagination.page, bad).toBe(1);
    }
  });

  it('counts with the same where as the page query, so the total honours every filter', async () => {
    mockJobFindMany.mockResolvedValueOnce([]);
    const req = authedReq({ query: { repositoryId: 'r-42', status: 'FAILED' } });
    const res = mockRes();

    await JobController.list(req, res);

    const pageWhere = mockJobFindMany.mock.calls[0][0].where;
    const countWhere = mockJobCount.mock.calls[0][0].where;
    expect(countWhere).toEqual(pageWhere);
    expect(countWhere.repository).toEqual({ userId: 'u-1' });
  });

  it('reports the real total even when the page itself is empty', async () => {
    // Page 12 of a 4-row list: no rows, but the count still says 4 so the UI
    // can clamp itself back to a valid page rather than showing "0 reviews".
    mockJobFindMany.mockResolvedValueOnce([]);
    mockJobCount.mockResolvedValueOnce(4);
    const req = authedReq({ query: { page: '12', limit: '50' } });
    const res = mockRes();

    await JobController.list(req, res);

    const out = res.json.mock.calls[0][0];
    expect(out.jobs).toEqual([]);
    expect(out.pagination).toEqual({ page: 12, limit: 50, total: 4, totalPages: 1 });
  });
});

describe('parseJobStatus', () => {
  it('accepts every enum value', () => {
    for (const status of [
      'QUEUED', 'FETCHING', 'ANALYZING', 'GENERATING', 'POSTING', 'RUNNING',
      'COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED', 'TIMEOUT',
    ]) {
      expect(parseJobStatus(status), status).toBe(status);
    }
  });

  it('rejects anything else, including case variants', () => {
    expect(parseJobStatus('completed')).toBeUndefined();
    expect(parseJobStatus('')).toBeUndefined();
    expect(parseJobStatus(undefined)).toBeUndefined();
    expect(parseJobStatus(null)).toBeUndefined();
    expect(parseJobStatus(123)).toBeUndefined();
  });
});

describe('JobController.get', () => {
  it('normalizes versioned adaptation conservatively, preserving protected and legacy findings', async () => {
    const { findingIdentity } = await import('../services/historical/occurrence.service');
    const finding = { filePath: 'src/a.ts', lineNumber: 1, agentType: 'STYLE' as const, priority: 'LOW' as const, issue: 'Naming', suggestion: 'Use conventions' };
    const entry = { findingKey: findingIdentity(finding), reviewedPrs: 5, rejectedPrs: 4, reason: 'STYLE_PREFERENCE', expiresAt: new Date(Date.now() + 86400000).toISOString() };
    const report = { version: 1, policyVersion: 'feedback_v1', entries: [entry] };
    expect(normalizeFindingAdaptation(finding, report)).toMatchObject({ policyVersion: 'feedback_v1', reviewedPrs: 5, rejectedPrs: 4 });
    expect(normalizeFindingAdaptation(finding, undefined)).toBeUndefined();
    expect(normalizeFindingAdaptation(finding, { ...report, version: 99 })).toBeUndefined();
    expect(normalizeFindingAdaptation(finding, { ...report, entries: [{ ...entry, expiresAt: new Date(0).toISOString() }] })).toBeUndefined();
    expect(normalizeFindingAdaptation(finding, { ...report, entries: [{ ...entry, rejectedPrs: 1 }] })).toBeUndefined();
    expect(normalizeFindingAdaptation({ ...finding, agentType: 'SECURITY' }, report)).toBeUndefined();
    expect(normalizeFindingAdaptation({ ...finding, corroborated: true }, report)).toBeUndefined();
  });
  it('attaches feedback by exact artifact identity rather than order or location', async () => {
    const { findingIdentity } = await import('../services/historical/occurrence.service');
    const finding = { filePath: 'src/a.ts', lineNumber: 1, agentType: 'BUG' as const, priority: 'HIGH' as const, issue: 'First defect', suggestion: 'Fix it' };
    const different = { ...finding, issue: 'Second defect at same location' };
    mockJobFindFirst.mockResolvedValueOnce({ id: 'job', status: 'COMPLETED', createdAt: new Date(),
      results: { suggestions: [finding, different], historicalMemory: { version: 1, algorithmVersion: 'fp_v2', suppliedPatternIds: ['p1'], patternCount: 5, truncated: true } },
      findingOccurrences: [
        { id: 'second-id', findingKey: findingIdentity(different), feedback: null },
        { id: 'first-id', findingKey: findingIdentity(finding), feedback: { disposition: 'ACCEPTED', rejectionReason: null, note: 'Internal note', revision: 3 } },
      ],
    });
    const response = mockRes();
    await JobController.get(authedReq({ params: { id: 'job' } }), response);
    const data = response.json.mock.calls[0][0].job;
    expect(data.results.map((f: any) => f.findingId)).toEqual(['first-id', 'second-id']);
    expect(data.results[0].feedback.revision).toBe(3);
    expect(data.metadata.historicalMemory).toEqual({ version: 1, algorithmVersion: 'fp_v2', suppliedPatternIds: ['p1'], patternCount: 1, truncated: true });
    expect(data).not.toHaveProperty('findingOccurrences');
  });
  it('returns updated v2 behavioral risk without exposing internal dispatch records', async () => {
    const { assessExplainableRisk } = await import('../services/security/risk-engine');
    const { baselineBehavioral } = await import('../services/behavioral/contracts');
    const testGaps = { analyzed: true, scenarios: [{ filePath: 'a.ts', lineNumber: 1, scenario: 'opens cart', expected: 'visible', confidence: 'HIGH' as const }], evidence: { changedSources: ['a.ts'], relatedTests: [], incomplete: false, treeTruncated: false } };
    const initial = baselineBehavioral(testGaps);
    mockJobFindFirst.mockResolvedValueOnce({
      id: 'j1', status: 'COMPLETED', securityChecks: [], ruleChecks: [],
      results: { suggestions: [], testGaps, includedFiles: ['a.ts'], risk: { score: 0, verdict: 'SAFE' }, riskV2: assessExplainableRisk([], { testGaps }) },
      behavioralRuns: [{ id: 'run', headSha: 'sha', ciRunId: '123', deadlineAt: new Date(Date.now() + 60000), status: 'FAILED', dispatchHash: 'do-not-expose', plan: [{ id: initial.scenarios[0].id, steps: [] }], evidence: [{ id: initial.scenarios[0].id, status: 'FAILED', steps: [{ index: 0, status: 'FAILED' }] }] }],
    });
    const response = mockRes();
    await JobController.get(authedReq({ params: { id: 'j1' } }), response);
    const data = response.json.mock.calls[0][0];
    expect(data.job.metadata.risk).toEqual({ score: 0, verdict: 'SAFE' });
    expect(data.job.metadata.riskV2).toMatchObject({ version: 2, score: 15, verdict: 'REVIEW' });
    expect(data.job.metadata.behavioral.scenarios[0]).toMatchObject({ status: 'FAILED', stage: 'EXECUTED' });
    expect(JSON.stringify(data)).not.toContain('do-not-expose');
    expect(data.job).not.toHaveProperty('behavioralRuns');
  });
  it('returns the job when it belongs to the user', async () => {
    mockJobFindFirst.mockResolvedValueOnce({ id: 'j1', status: 'COMPLETED', results: null });
    const req = authedReq({ params: { id: 'j1' } });
    const res = mockRes();

    await JobController.get(req, res);

    expect(res.json).toHaveBeenCalledWith({
      job: {
        id: 'j1',
        status: 'COMPLETED',
        results: [],
        metadata: { ignoredFiles: [], includedFiles: [], error: undefined, historicalFeedbackEligible: false },
      },
    });
  });

  it('surfaces the persisted test-gap report via metadata', async () => {
    const contextDiscovery = { version: 1, status: 'PARTIAL', indexedFiles: 100, eligibleFiles: 200, selectedFiles: 0, reasons: ['DOWNLOAD_LIMIT'] };
    const testGaps = {
      analyzed: true,
      scenarios: [{ filePath: 'src/db.ts', scenario: 'missing edge case' }],
      evidence: {
        changedSources: ['src/db.ts'],
        relatedTests: [],
        treeTruncated: false,
        incomplete: false,
      },
    };
    mockJobFindFirst.mockResolvedValueOnce({
      id: 'j3',
      status: 'COMPLETED',
      results: { testGaps, contextDiscovery },
    });
    const req = authedReq({ params: { id: 'j3' } });
    const res = mockRes();

    await JobController.get(req, res);

    const out = (res.json as any).mock.calls[0][0];
    expect(out.job.metadata.testGaps).toEqual(testGaps);
    expect(out.job.metadata.contextDiscovery).toEqual(contextDiscovery);
    // Test gaps stay out of the findings array.
    expect(out.job.results).toEqual([]);
  });

  it('exposes ignored/included files and the error message from results', async () => {
    mockJobFindFirst.mockResolvedValueOnce({
      id: 'j2',
      status: 'SKIPPED',
      results: { ignoredFiles: ['dist/**'], includedFiles: ['src/**'], error: 'No API key' },
    });
    const req = authedReq({ params: { id: 'j2' } });
    const res = mockRes();

    await JobController.get(req, res);

    const out = res.json.mock.calls[0][0];
    expect(out.job.metadata).toEqual({
      ignoredFiles: ['dist/**'],
      includedFiles: ['src/**'],
      error: 'No API key',
      historicalFeedbackEligible: false,
    });
    expect(out.job.results).toEqual([]);
  });

  it('returns 404 when the job is missing or owned by another user', async () => {
    mockJobFindFirst.mockResolvedValueOnce(null);
    const req = authedReq({ params: { id: 'j-not-mine' } });
    const res = mockRes();

    await JobController.get(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Job not found' });
  });

  it('always filters by auth.userId (IDOR guard)', async () => {
    mockJobFindFirst.mockResolvedValueOnce(null);
    const req = authedReq({ params: { id: 'j1' } });
    const res = mockRes();

    await JobController.get(req, res);

    const arg = mockJobFindFirst.mock.calls[0][0];
    expect(arg.where.id).toBe('j1');
    expect(arg.where.repository).toEqual({ userId: 'u-1' });
  });
});

describe('JobController.cancel', () => {
  const queuedJob = { id: 'j1', status: 'ANALYZING' };

  beforeEach(() => {
    mockQueueRemove.mockResolvedValue(1);
  });

  it('cancels an in-flight review and persists CANCELLED', async () => {
    mockJobFindFirst.mockResolvedValueOnce(queuedJob);

    const req = authedReq({ params: { id: 'j1' } });
    const res = mockRes();

    await JobController.cancel(req, res);

    expect(mockJobUpdate).toHaveBeenCalledWith({
      where: { id: 'j1' },
      data: { status: 'CANCELLED', results: { reason: 'cancelled-by-user' } },
    });
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ status: 'CANCELLED', id: 'j1' });
  });

  it('removes the job from the queue so a queued review never starts', async () => {
    mockJobFindFirst.mockResolvedValueOnce(queuedJob);

    await JobController.cancel(authedReq({ params: { id: 'j1' } }), mockRes());

    expect(mockQueueRemove).toHaveBeenCalledWith('j1');
  });

  it('cancels in every in-flight phase', async () => {
    for (const status of ['QUEUED', 'FETCHING', 'ANALYZING', 'GENERATING', 'POSTING']) {
      mockJobFindFirst.mockResolvedValueOnce({ id: 'j1', status });
      const res = mockRes();
      await JobController.cancel(authedReq({ params: { id: 'j1' } }), res);
      expect(res.json, status).toHaveBeenCalledWith({ status: 'CANCELLED', id: 'j1' });
    }
  });

  it('notifies the dashboard so the UI updates without a reload', async () => {
    mockJobFindFirst.mockResolvedValueOnce(queuedJob);

    await JobController.cancel(authedReq({ params: { id: 'j1' } }), mockRes());

    expect(mockEmitStatus).toHaveBeenCalledWith(
      'u-1',
      'j1',
      expect.stringContaining('cancelled'),
      'CANCELLED',
    );
  });

  it('still persists CANCELLED when the queue removal fails', async () => {
    // queue.remove cannot stop a job that already holds its lock, and a Redis
    // error must not strand the review as permanently running.
    mockJobFindFirst.mockResolvedValueOnce(queuedJob);
    mockQueueRemove.mockRejectedValueOnce(new Error('redis down'));

    const res = mockRes();
    await JobController.cancel(authedReq({ params: { id: 'j1' } }), res);

    expect(mockJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) }),
    );
    expect(res.json).toHaveBeenCalledWith({ status: 'CANCELLED', id: 'j1' });
  });

  it('still persists CANCELLED when the job was already running', async () => {
    mockJobFindFirst.mockResolvedValueOnce(queuedJob);
    mockQueueRemove.mockResolvedValue(0); // not found in queue == already running

    const res = mockRes();
    await JobController.cancel(authedReq({ params: { id: 'j1' } }), res);

    expect(mockJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) }),
    );
  });

  it('refuses to cancel a finished review with 409', async () => {
    // The user pressed cancel on a review whose comments are already on the PR.
    // Reporting success would be a lie.
    mockJobFindFirst.mockResolvedValueOnce({ id: 'j1', status: 'COMPLETED' });

    const res = mockRes();
    await JobController.cancel(authedReq({ params: { id: 'j1' } }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: expect.stringContaining('COMPLETED'),
      status: 'COMPLETED',
    });
    expect(mockJobUpdate).not.toHaveBeenCalled();
    expect(mockQueueRemove).not.toHaveBeenCalled();
  });

  it('refuses to cancel an already-cancelled review', async () => {
    mockJobFindFirst.mockResolvedValueOnce({ id: 'j1', status: 'CANCELLED' });

    const res = mockRes();
    await JobController.cancel(authedReq({ params: { id: 'j1' } }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockJobUpdate).not.toHaveBeenCalled();
  });

  it('refuses to cancel a timed-out review', async () => {
    mockJobFindFirst.mockResolvedValueOnce({ id: 'j1', status: 'TIMEOUT' });

    const res = mockRes();
    await JobController.cancel(authedReq({ params: { id: 'j1' } }), res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('returns 404 for a job owned by another user', async () => {
    mockJobFindFirst.mockResolvedValueOnce(null);

    const res = mockRes();
    await JobController.cancel(authedReq({ params: { id: 'j-not-mine' } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockJobUpdate).not.toHaveBeenCalled();
  });

  it('scopes the lookup to the authenticated user (IDOR guard)', async () => {
    mockJobFindFirst.mockResolvedValueOnce(null);

    await JobController.cancel(authedReq({ params: { id: 'j1' } }), mockRes());

    const where = mockJobFindFirst.mock.calls[0][0].where;
    expect(where.id).toBe('j1');
    expect(where.repository).toEqual({ userId: 'u-1' });
  });
});
