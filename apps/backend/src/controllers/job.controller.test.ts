import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockJobFindMany, mockJobFindFirst } = vi.hoisted(() => ({
  mockJobFindMany: vi.fn(),
  mockJobFindFirst: vi.fn(),
}));

vi.mock('../config/prisma', () => ({
  default: {
    analysisJob: { findMany: mockJobFindMany, findFirst: mockJobFindFirst },
  },
}));

import { JobController, parseJobStatus } from './job.controller';
import { mockReq, mockRes } from '../test-utils/express-mocks';

const authedReq = (overrides = {}) => {
  const req = mockReq(overrides);
  (req as any).auth = { userId: 'u-1', githubId: 'gh' };
  return req;
};

beforeEach(() => {
  vi.clearAllMocks();
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
    expect(res.json).toHaveBeenCalledWith({ jobs: [] });
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
        metadata: { ignoredFiles: [], includedFiles: [], error: undefined },
      },
    });
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
