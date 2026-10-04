import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockJobFindUnique, mockJobUpdate, mockEmitStatus } = vi.hoisted(() => ({
  mockJobFindUnique: vi.fn(),
  mockJobUpdate: vi.fn(),
  mockEmitStatus: vi.fn(),
}));

vi.mock('../config/prisma', () => ({
  default: {
    analysisJob: { findUnique: mockJobFindUnique, update: mockJobUpdate },
  },
}));

vi.mock('../config/socket', () => ({
  SocketService: { emitStatus: mockEmitStatus },
}));

import {
  SUPERSEDED_REVIEW_STATUSES,
  TERMINAL_REVIEW_STATUSES,
  isInProgressStatus,
  isSupersededStatus,
  isTerminalStatus,
  markReviewTerminal,
  wasSuperseded,
} from './job-state';

beforeEach(() => {
  vi.resetAllMocks();
  mockJobUpdate.mockResolvedValue({});
});

describe('terminal status predicates', () => {
  it('treats every documented terminal state as terminal', () => {
    // The roadmap's failure set: FAILED, CANCELLED, TIMEOUT.
    for (const status of ['FAILED', 'CANCELLED', 'TIMEOUT'] as const) {
      expect(isTerminalStatus(status), status).toBe(true);
    }
    expect(isTerminalStatus('COMPLETED')).toBe(true);
    expect(isTerminalStatus('SKIPPED')).toBe(true);
  });

  it('does not treat in-flight phases as terminal', () => {
    for (const status of ['QUEUED', 'FETCHING', 'ANALYZING', 'GENERATING', 'POSTING']) {
      expect(isTerminalStatus(status), status).toBe(false);
    }
  });

  it('identifies the two states that supersede a running attempt', () => {
    expect([...SUPERSEDED_REVIEW_STATUSES]).toEqual(['CANCELLED', 'TIMEOUT']);
    expect(isSupersededStatus('CANCELLED')).toBe(true);
    expect(isSupersededStatus('TIMEOUT')).toBe(true);
  });

  it('does not treat FAILED or COMPLETED as superseding', () => {
    // A failed or finished review is not something a worker must abandon — it is
    // simply over. Only an external stop should halt an in-flight attempt.
    expect(isSupersededStatus('FAILED')).toBe(false);
    expect(isSupersededStatus('COMPLETED')).toBe(false);
  });

  it('handles non-string input without throwing', () => {
    for (const bad of [undefined, null, 42, {}, []]) {
      expect(isTerminalStatus(bad)).toBe(false);
      expect(isSupersededStatus(bad)).toBe(false);
    }
  });

  it('lists no duplicates', () => {
    expect(new Set(TERMINAL_REVIEW_STATUSES).size).toBe(TERMINAL_REVIEW_STATUSES.length);
  });
});

describe('isInProgressStatus', () => {
  it('covers every phase of the pipeline, so cancelling works in each', () => {
    for (const status of ['QUEUED', 'FETCHING', 'ANALYZING', 'GENERATING', 'POSTING', 'RUNNING']) {
      expect(isInProgressStatus(status), status).toBe(true);
    }
  });

  it('excludes everything that already finished', () => {
    for (const status of ['COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED', 'TIMEOUT']) {
      expect(isInProgressStatus(status), status).toBe(false);
    }
  });

  it('does not overlap with the terminal set', () => {
    for (const status of TERMINAL_REVIEW_STATUSES) {
      expect(isInProgressStatus(status), status).toBe(false);
    }
  });
});

describe('wasSuperseded', () => {
  it('reports true when the review was cancelled', async () => {
    mockJobFindUnique.mockResolvedValueOnce({ status: 'CANCELLED' });
    await expect(wasSuperseded('job-1')).resolves.toBe(true);
  });

  it('reports true when the review timed out', async () => {
    mockJobFindUnique.mockResolvedValueOnce({ status: 'TIMEOUT' });
    await expect(wasSuperseded('job-1')).resolves.toBe(true);
  });

  it('reports false mid-pipeline', async () => {
    mockJobFindUnique.mockResolvedValueOnce({ status: 'ANALYZING' });
    await expect(wasSuperseded('job-1')).resolves.toBe(false);
  });

  it('reads only the status column', async () => {
    mockJobFindUnique.mockResolvedValueOnce({ status: 'FETCHING' });
    await wasSuperseded('job-1');
    expect(mockJobFindUnique).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      select: { status: true },
    });
  });
});

describe('markReviewTerminal', () => {
  it('persists TIMEOUT with the reason attached', async () => {
    await markReviewTerminal('job-1', 'u-1', 'TIMEOUT', 'timed out', { reason: 'review-timeout' });

    expect(mockJobUpdate).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: {
        status: 'TIMEOUT',
        results: { reason: 'review-timeout' },
      },
    });
  });

  it('persists CANCELLED', async () => {
    await markReviewTerminal('job-1', 'u-1', 'CANCELLED', 'cancelled', { reason: 'cancelled-by-user' });

    expect(mockJobUpdate).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: {
        status: 'CANCELLED',
        results: { reason: 'cancelled-by-user' },
      },
    });
  });

  it('omits results entirely when none are supplied', async () => {
    await markReviewTerminal('job-1', 'u-1', 'CANCELLED', 'cancelled');

    expect(mockJobUpdate.mock.calls[0][0].data).not.toHaveProperty('results');
  });

  it('mirrors the terminal state to the dashboard', async () => {
    await markReviewTerminal('job-1', 'u-1', 'TIMEOUT', 'Review timed out');

    expect(mockEmitStatus).toHaveBeenCalledWith('u-1', 'job-1', 'Review timed out', 'TIMEOUT');
  });

  it('emits before the write settles so the dashboard is not left waiting', async () => {
    // The socket push is what makes a cancellation feel immediate; the DB write
    // is the durable record. Order matters less than both happening.
    await markReviewTerminal('job-1', 'u-1', 'CANCELLED', 'bye');
    expect(mockEmitStatus).toHaveBeenCalledOnce();
  });
});