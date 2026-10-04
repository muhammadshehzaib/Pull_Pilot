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
  REVIEW_PHASES,
  SUPERSEDED_REVIEW_STATUSES,
  TERMINAL_REVIEW_STATUSES,
  advanceReview,
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

describe('advanceReview', () => {
  const advanceFrom = (status: string | null, phase: (typeof REVIEW_PHASES)[number] = 'FETCHING') => {
    mockJobFindUnique.mockResolvedValue(status === null ? null : { status });
    return advanceReview('job-1', 'u-1', phase, `msg:${phase}`);
  };

  it('records the first phase of a queued review', async () => {
    await advanceFrom('QUEUED');

    expect(mockJobUpdate).toHaveBeenCalledWith({ where: { id: 'job-1' }, data: { status: 'FETCHING' } });
    expect(mockEmitStatus).toHaveBeenCalledWith('u-1', 'job-1', 'msg:FETCHING', 'FETCHING');
  });

  it('moves forward through the pipeline', async () => {
    await advanceFrom('FETCHING', 'ANALYZING');
    expect(mockJobUpdate).toHaveBeenCalledWith({ where: { id: 'job-1' }, data: { status: 'ANALYZING' } });
  });

  it('refuses to move backwards', async () => {
    // A late write from an earlier step must not make a review that is already
    // posting look like it is still analysing.
    await advanceFrom('POSTING', 'FETCHING');

    expect(mockJobUpdate).not.toHaveBeenCalled();
    expect(mockEmitStatus).not.toHaveBeenCalled();
  });

  it('ignores a repeat of the current phase', async () => {
    await advanceFrom('ANALYZING', 'ANALYZING');

    expect(mockJobUpdate).not.toHaveBeenCalled();
    expect(mockEmitStatus).not.toHaveBeenCalled();
  });

  it('lets a retry re-enter the pipeline at FETCHING from a phase', async () => {
    // BullMQ retries restart at FETCHING; a genuine restart must be allowed to
    // record it, even though FETCHING ranks below POSTING.
    await advanceFrom('POSTING', 'FETCHING');
    expect(mockJobUpdate).not.toHaveBeenCalled();

    mockJobUpdate.mockClear();
    await advanceFrom('FAILED', 'FETCHING');
    expect(mockJobUpdate).not.toHaveBeenCalled();
  });

  it('does not resurrect a review that already finished', async () => {
    // Regression guard: BullMQ re-delivers a job whose worker died before it
    // could record the abort. Without this, a cancelled review that coincided
    // with a crash restarts and posts comments on a PR the user stopped.
    for (const status of TERMINAL_REVIEW_STATUSES) {
      mockJobUpdate.mockClear();
      mockEmitStatus.mockClear();
      await advanceFrom(status, 'FETCHING');

      expect(mockJobUpdate, `status ${status}`).not.toHaveBeenCalled();
      expect(mockEmitStatus, `status ${status}`).not.toHaveBeenCalled();
    }
  });

  it('does not resurrect a cancelled or timed-out review', async () => {
    for (const status of SUPERSEDED_REVIEW_STATUSES) {
      mockJobUpdate.mockClear();
      await advanceFrom(status, 'POSTING');
      expect(mockJobUpdate, `status ${status}`).not.toHaveBeenCalled();
    }
  });

  it('advances when the row is missing', async () => {
    // A deleted job is not a reason to skip the write.
    await advanceFrom(null);

    expect(mockJobUpdate).toHaveBeenCalledWith({ where: { id: 'job-1' }, data: { status: 'FETCHING' } });
  });
});