import { describe, it, expect, vi, beforeEach } from 'vitest';

const update = vi.fn();
const findUnique = vi.fn();
const emitStatus = vi.fn();

vi.mock('../config/prisma', () => ({
  default: { analysisJob: { update: (...a: unknown[]) => update(...a), findUnique: (...a: unknown[]) => findUnique(...a) } },
}));
vi.mock('../config/socket', () => ({
  SocketService: { emitStatus: (...a: unknown[]) => emitStatus(...a) },
}));

import { advanceReview, isReviewPhase } from './job-state';

beforeEach(() => {
  update.mockReset();
  findUnique.mockReset();
  emitStatus.mockReset();
  update.mockResolvedValue({});
  findUnique.mockResolvedValue({ status: 'QUEUED' });
});

describe('isReviewPhase', () => {
  it('accepts the pipeline phases', () => {
    expect(isReviewPhase('FETCHING')).toBe(true);
    expect(isReviewPhase('POSTING')).toBe(true);
  });

  it('rejects terminal and unknown states', () => {
    expect(isReviewPhase('COMPLETED')).toBe(false);
    expect(isReviewPhase('RUNNING')).toBe(false);
    expect(isReviewPhase(undefined)).toBe(false);
  });
});

describe('advanceReview', () => {
  it('persists the phase and notifies the dashboard', async () => {
    await advanceReview('job-1', 'user-1', 'ANALYZING', 'thinking');

    expect(update).toHaveBeenCalledWith({ where: { id: 'job-1' }, data: { status: 'ANALYZING' } });
    expect(emitStatus).toHaveBeenCalledWith('user-1', 'job-1', 'thinking', 'ANALYZING');
  });

  it('advances forward through the pipeline', async () => {
    findUnique.mockResolvedValue({ status: 'ANALYZING' });
    await advanceReview('job-1', 'user-1', 'POSTING', 'posting');
    expect(update).toHaveBeenCalledWith({ where: { id: 'job-1' }, data: { status: 'POSTING' } });
  });

  it('refuses to move backwards so a late write cannot rewind a review', async () => {
    findUnique.mockResolvedValue({ status: 'POSTING' });
    await advanceReview('job-1', 'user-1', 'ANALYZING', 'rewind');

    expect(update).not.toHaveBeenCalled();
    expect(emitStatus).not.toHaveBeenCalled();
  });

  it('treats a retry re-entering at the same phase as a no-op', async () => {
    findUnique.mockResolvedValue({ status: 'FETCHING' });
    await advanceReview('job-1', 'user-1', 'FETCHING', 'again');
    expect(update).not.toHaveBeenCalled();
  });

  it('still advances out of a terminal-looking pre-pipeline state', async () => {
    findUnique.mockResolvedValue({ status: 'COMPLETED' });
    await advanceReview('job-1', 'user-1', 'FETCHING', 'retry after failure');
    expect(update).toHaveBeenCalledWith({ where: { id: 'job-1' }, data: { status: 'FETCHING' } });
  });
});
