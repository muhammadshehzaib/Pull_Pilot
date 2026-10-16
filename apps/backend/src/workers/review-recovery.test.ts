import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { lifecycleDb as db, lifecycleState as state, resetLifecycleDb } from '../test-utils/review-lifecycle-db';

vi.mock('../config/prisma', async () => ({ default: (await import('../test-utils/review-lifecycle-db')).lifecycleDb }));
const { getJob, getJobs, getJobCounts, emit } = vi.hoisted(() => ({ getJob: vi.fn(), getJobs: vi.fn(), getJobCounts: vi.fn(), emit: vi.fn() }));
vi.mock('../config/queue', () => ({ analysisQueue: { getJob, getJobs, getJobCounts } }));
vi.mock('../config/socket', () => ({ SocketService: { emitStatus: emit } }));
import { recoverReviewsOnce, cancelDisconnectedReviews, settleFailedQueueJob, startReviewRecovery, ABANDONED_REVIEW_GRACE_MS } from './review-recovery';
import { markReviewTerminal, persistReviewFailure } from './job-state';
import { QuotaService } from '../services/quota.service';

const old = () => new Date(Date.now() - ABANDONED_REVIEW_GRACE_MS - 1000);
function review(overrides: Record<string, any> = {}) {
  const row = { id: 'job', repositoryId: 'repo', status: 'GENERATING', createdAt: old(), updatedAt: old(),
    queueJobId: 'job', quotaLedgerId: 'original-ledger', quotaIsPrivate: true, quotaRefundedAt: null,
    results: { suggestions: [{ issue: 'Keep saved findings' }] }, ...overrides };
  state.jobs.push(row); return row;
}
function queued(status: string, overrides: Record<string, any> = {}) {
  return { id: 'job', data: { jobId: 'job', repositoryId: 'repo', userId: 'user' }, getState: vi.fn(async () => status),
    processedOn: old().getTime(), ...overrides } as unknown as Job;
}
beforeEach(() => {
  vi.clearAllMocks(); resetLifecycleDb();
  state.ledgers.push({ id: 'original-ledger', installationId: 'install', billingMonth: '2026-01', privateReviewsCount: 1, publicReviewsCount: 1 });
  getJob.mockResolvedValue(undefined); getJobs.mockResolvedValue([]); getJobCounts.mockResolvedValue({ active: 0, waiting: 0, delayed: 0, failed: 0 });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('abandoned review reconciliation', () => {
  it('closes disconnected reviews immediately, preserves findings, and refunds once', async () => {
    const row = review({ updatedAt: new Date() }); state.repos[0].isActive = false;
    await cancelDisconnectedReviews('repo'); await recoverReviewsOnce();
    expect(row.status).toBe('CANCELLED');
    expect(row.results).toMatchObject({ suggestions: [{ issue: 'Keep saved findings' }], reason: 'repository-disconnected' });
    expect(state.ledgers[0].privateReviewsCount).toBe(0); expect(row.quotaRefundedAt).toBeInstanceOf(Date);
    expect(getJob).not.toHaveBeenCalled(); expect(emit).toHaveBeenCalledOnce();
  });
  it('settles exhausted/stalled queue jobs when the processor never recorded failure', async () => {
    const row = review(); getJob.mockResolvedValue(queued('failed'));
    await recoverReviewsOnce(); await settleFailedQueueJob(queued('failed'));
    expect(row.status).toBe('FAILED'); expect(state.ledgers[0].privateReviewsCount).toBe(0);
    expect(emit).toHaveBeenCalledOnce();
  });
  it.each(['waiting', 'delayed', 'paused', 'prioritized', 'waiting-children'])('preserves legitimate %s work and its reservation', async queueState => {
    const row = review(); getJob.mockResolvedValue(queued(queueState));
    await recoverReviewsOnce(); expect(row.status).toBe('GENERATING'); expect(state.ledgers[0].privateReviewsCount).toBe(1);
  });
  it('preserves an active worker whose heartbeat refreshed the database', async () => {
    const row = review({ updatedAt: new Date(), lastHeartbeatAt: new Date() }); getJob.mockResolvedValue(queued('active'));
    await recoverReviewsOnce(); expect(row.status).toBe('GENERATING');
  });
  it('protects a newly started retry before its first heartbeat', async () => {
    const row = review(); getJob.mockResolvedValue(queued('active', { processedOn: Date.now() }));
    await recoverReviewsOnce(); expect(row.status).toBe('GENERATING');
  });
  it('times out an active job only after its progress and queue-start grace expire', async () => {
    const row = review(); getJob.mockResolvedValue(queued('active'));
    await recoverReviewsOnce(); expect(row.status).toBe('TIMEOUT'); expect(state.ledgers[0].privateReviewsCount).toBe(0);
  });
  it('cleans up a missing queue job after the grace period, including enqueue crash windows', async () => {
    const row = review(); await recoverReviewsOnce(); expect(row.status).toBe('FAILED');
    expect(state.ledgers[0].privateReviewsCount).toBe(0);
  });
  it('does not race a recently created review before enqueueing', async () => {
    const row = review({ status: 'QUEUED', updatedAt: new Date() });
    await recoverReviewsOnce(); expect(row.status).toBe('QUEUED');
  });
  it('closes a queue-completed job whose database completion was never published', async () => {
    const row = review(); getJob.mockResolvedValue(queued('completed'));
    await recoverReviewsOnce(); expect(row.status).toBe('FAILED'); expect(row.results.reason).toBe('queue-ended-without-completion');
  });
  it('does not overwrite completion racing the recovery snapshot', async () => {
    const row = review(); getJob.mockImplementationOnce(async () => {
      await db.analysisJob.update({ where: { id: 'job' }, data: { status: 'COMPLETED' } }); return queued('failed');
    });
    await recoverReviewsOnce(); expect(row.status).toBe('COMPLETED'); expect(state.ledgers[0].privateReviewsCount).toBe(1);
  });
  it('does not overwrite a heartbeat racing the recovery snapshot', async () => {
    const row = review(); getJob.mockImplementationOnce(async () => {
      await db.analysisJob.update({ where: { id: 'job' }, data: { updatedAt: new Date() } }); return queued('active');
    });
    await recoverReviewsOnce(); expect(row.status).toBe('GENERATING'); expect(row.quotaRefundedAt).toBeNull();
  });
  it('leaves active reviews unchanged when Redis is unavailable but still cancels disconnected ones', async () => {
    const row = review(); state.repos.push({ id: 'repo-2', userId: 'other', isActive: false });
    const disconnected = review({ id: 'job-2', repositoryId: 'repo-2', quotaLedgerId: null });
    getJob.mockRejectedValue(new Error('private-redis-connection-secret'));
    await recoverReviewsOnce(); expect(row.status).toBe('GENERATING'); expect(disconnected.status).toBe('CANCELLED');
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private-redis-connection-secret');
    getJob.mockResolvedValue(undefined);
  });
  it('adopts a legacy numeric queue ID and preserves queued work', async () => {
    const row = review({ queueJobId: null, quotaLedgerId: null }); getJobs.mockResolvedValue([queued('waiting', { id: '123' })]);
    await recoverReviewsOnce(); expect(row.queueJobId).toBe('123'); expect(row.status).toBe('GENERATING');
  });
  it('settles a missing legacy review without guessing an untracked refund', async () => {
    const row = review({ queueJobId: null, quotaLedgerId: null }); await recoverReviewsOnce();
    expect(row.status).toBe('FAILED'); expect(state.ledgers[0].privateReviewsCount).toBe(1);
  });
  it('never infers legacy absence from a truncated queue listing', async () => {
    const row = review({ queueJobId: null }); getJobCounts.mockResolvedValue({ waiting: 1001 });
    await recoverReviewsOnce(); expect(row.status).toBe('GENERATING');
  });
  it('recovers a new review even if the producer crashed before reserving quota', async () => {
    const row = review({ queueJobId: null, quotaLedgerId: null, queueVersion: 1 });
    getJobCounts.mockResolvedValue({ waiting: 5000 });
    await recoverReviewsOnce(); expect(row.status).toBe('FAILED'); expect(getJobs).not.toHaveBeenCalled();
    expect(state.ledgers[0].privateReviewsCount).toBe(1);
  });
  it('treats a full legacy sample as incomplete even if queue counts subsequently shrink', async () => {
    const row = review({ queueJobId: null });
    getJobs.mockResolvedValue(Array.from({ length: 1001 }, (_, index) => queued('waiting', { data: { jobId: `other-${index}` } })));
    await recoverReviewsOnce(); expect(row.status).toBe('GENERATING');
  });
  it('refuses mismatched queue ownership and never emits to another customer', async () => {
    const row = review(); getJob.mockResolvedValue(queued('failed', { data: { jobId: 'job', repositoryId: 'repo', userId: 'intruder' } }));
    await recoverReviewsOnce(); expect(row.status).toBe('GENERATING'); expect(emit).not.toHaveBeenCalled();
    await settleFailedQueueJob(queued('failed', { data: { jobId: 'job', repositoryId: 'foreign', userId: 'user' } }));
    expect(row.status).toBe('GENERATING');
  });
  it('does not settle retryable failed events before the queue is terminal', async () => {
    const row = review(); await settleFailedQueueJob(queued('delayed')); expect(row.status).toBe('GENERATING');
  });
  it('checks bounded batches with a cursor so healthy jobs do not starve old failures', async () => {
    for (let index = 0; index < 101; index++) review({ id: `job-${String(index).padStart(3, '0')}`, updatedAt: new Date() });
    const first = await recoverReviewsOnce(); expect(first.checked).toBe(100); expect(first.nextCursor).toBe('job-099');
    const second = await recoverReviewsOnce(first.nextCursor); expect(second.checked).toBe(1); expect(second.nextCursor).toBeUndefined();
  });
  it('runs on startup and retries safely after a database outage', async () => {
    vi.useFakeTimers(); const row = review();
    db.analysisJob.findMany.mockRejectedValueOnce(new Error('outage'));
    const stop = startReviewRecovery(); await vi.advanceTimersByTimeAsync(0);
    expect(row.status).toBe('GENERATING'); await vi.advanceTimersByTimeAsync(60_000);
    expect(row.status).toBe('FAILED'); stop();
  });
  it('does not overlap maintenance cycles while a database read is pending', async () => {
    vi.useFakeTimers();
    let release!: (rows: unknown[]) => void;
    db.analysisJob.findMany.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const stop = startReviewRecovery(); await vi.advanceTimersByTimeAsync(120_000);
    expect(db.analysisJob.findMany).toHaveBeenCalledTimes(1);
    release([]); await vi.advanceTimersByTimeAsync(60_000);
    expect(db.analysisJob.findMany).toHaveBeenCalledTimes(2); stop();
  });
  it('bounds hung Redis reads without treating an outage as a missing queue job', async () => {
    vi.useFakeTimers(); const row = review();
    getJob.mockImplementationOnce(() => new Promise(() => {}));
    const sweep = recoverReviewsOnce(); await vi.advanceTimersByTimeAsync(3001);
    await sweep; expect(row.status).toBe('GENERATING'); expect(row.quotaRefundedAt).toBeNull();
  });
});

describe('durable quota reservation and terminal refunds', () => {
  it('shares the last Free slot across legacy installations and direct connections', async () => {
    const month = QuotaService.getCurrentBillingMonth();
    state.installations.push({ id: 'other-install', userId: 'user', plan: 'FREE' });
    state.ledgers.push({ id: 'old-install', installationId: 'install', billingMonth: month, privateReviewsCount: 20 },
      { id: 'other-install-ledger', installationId: 'other-install', billingMonth: month, privateReviewsCount: 20 },
      { id: 'direct-ledger', userId: 'user', billingMonth: month, privateReviewsCount: 9, publicReviewsCount: 0 });
    state.repos.push({ ...state.repos[0], id: 'direct-repo', installationId: null });
    review({ id: 'installed-job', status: 'QUEUED', quotaLedgerId: null });
    review({ id: 'direct-job', repositoryId: 'direct-repo', status: 'QUEUED', quotaLedgerId: null });
    const results = await Promise.all([
      QuotaService.reserveReview('install', true, 'user', 'installed-job'),
      QuotaService.reserveReview(null, true, 'user', 'direct-job'),
    ]);
    expect(results.filter(r => r.allowed)).toHaveLength(1);
    expect((await QuotaService.getAccountUsage('user', month)).privateReviewsCount).toBe(50);
    expect(state.jobs.filter((j: any) => j.quotaLedgerId)).toHaveLength(1);
  });
  it('blocks a second private repository without charging and lets it take over after disconnection', async () => {
    state.repos.push({ ...state.repos[0], id: 'second', githubRepoId: 2n, installationId: null });
    const row = review({ repositoryId: 'second', status: 'QUEUED', quotaLedgerId: null });
    const denied = await QuotaService.reserveReview(null, true, 'user', 'job');
    expect(denied.allowed).toBe(false); expect(denied.reason).toContain('one active private repository');
    expect(row.quotaLedgerId).toBeNull();
    state.repos[0].isActive = false;
    expect((await QuotaService.reserveReview(null, true, 'user', 'job')).allowed).toBe(true);
  });
  it('leaves paid private repositories and public repositories unrestricted', async () => {
    state.repos.push({ ...state.repos[0], id: 'second', githubRepoId: 2n, installationId: null });
    review({ repositoryId: 'second', status: 'QUEUED', quotaLedgerId: null });
    db.subscription.findFirst.mockResolvedValueOnce({ plan: 'INDIE', status: 'active' });
    expect((await QuotaService.reserveReview(null, true, 'user', 'job')).allowed).toBe(true);
    review({ id: 'public-job', repositoryId: 'second', status: 'QUEUED', quotaLedgerId: null });
    expect((await QuotaService.reserveReview(null, false, 'user', 'public-job')).allowed).toBe(true);
  });
  it('retains account usage after an installation is removed', async () => {
    const row = review({ status: 'QUEUED', quotaLedgerId: null });
    await QuotaService.reserveReview('install', true, 'user', 'job');
    state.installations = [];
    expect((await QuotaService.getAccountUsage('user', QuotaService.getCurrentBillingMonth())).privateReviewsCount).toBe(1);
    await markReviewTerminal(row.id, 'user', 'FAILED', 'failed');
    expect((await QuotaService.getAccountUsage('user', QuotaService.getCurrentBillingMonth())).privateReviewsCount).toBe(0);
  });
  it('charges one slot for concurrent reservations of the same owned review', async () => {
    const row = review({ status: 'QUEUED', quotaLedgerId: null, quotaIsPrivate: null });
    const results = await Promise.all([QuotaService.reserveReview('install', true, 'user', 'job'), QuotaService.reserveReview('install', true, 'user', 'job')]);
    expect(results.every(r => r.allowed)).toBe(true); expect(row.quotaLedgerId).toBeTruthy(); expect(row.queueJobId).toBe('job');
    expect(state.ledgers.find((l: any) => l.id === row.quotaLedgerId).privateReviewsCount).toBe(1);
  });
  it('reserves user-owned legacy mode and public counters with a refund receipt', async () => {
    state.repos[0].installationId = null;
    const row = review({ status: 'QUEUED', quotaLedgerId: null, quotaIsPrivate: null });
    expect((await QuotaService.reserveReview(null, false, 'user', 'job')).allowed).toBe(true);
    await markReviewTerminal('job', 'user', 'CANCELLED', 'cancelled');
    expect(state.ledgers.find((l: any) => l.id === row.quotaLedgerId).publicReviewsCount).toBe(0);
  });
  it('refuses another customer or billing owner before charging', async () => {
    review({ quotaLedgerId: null });
    await expect(QuotaService.reserveReview('install', true, 'intruder', 'job')).rejects.toThrow('unavailable');
    await expect(QuotaService.reserveReview('other-install', true, 'user', 'job')).rejects.toThrow('unavailable');
    expect(db.usageLedger.updateMany).not.toHaveBeenCalled();
  });
  it('does not create a receipt or spend quota when the free limit is reached', async () => {
    const row = review({ quotaLedgerId: null }); state.ledgers.push({ id: 'full', installationId: 'install', billingMonth: QuotaService.getCurrentBillingMonth(), privateReviewsCount: 50, publicReviewsCount: 0 });
    expect((await QuotaService.reserveReview('install', true, 'user', 'job')).allowed).toBe(false);
    expect(row.quotaLedgerId).toBeNull(); expect(state.ledgers.at(-1).privateReviewsCount).toBe(50);
  });
  it('rolls back a charge if saving its receipt fails', async () => {
    review({ quotaLedgerId: null }); db.analysisJob.update.mockRejectedValueOnce(new Error('receipt write failed'));
    await expect(QuotaService.reserveReview('install', true, 'user', 'job')).rejects.toThrow('receipt');
    expect(state.jobs[0].quotaLedgerId).toBeNull(); expect(state.ledgers).toHaveLength(1);
  });
  it('refunds the original month exactly once under concurrent terminal writes', async () => {
    review(); state.ledgers.push({ id: 'current-month', installationId: 'install', billingMonth: QuotaService.getCurrentBillingMonth(), privateReviewsCount: 9 });
    await Promise.all([markReviewTerminal('job', 'user', 'CANCELLED', 'cancel'), markReviewTerminal('job', 'user', 'FAILED', 'failed')]);
    expect(state.ledgers[0].privateReviewsCount).toBe(0); expect(state.ledgers[1].privateReviewsCount).toBe(9);
  });
  it('keeps the charge across retries and refunds only a final failure', async () => {
    const row = review(); await persistReviewFailure('job', 'user', 'RETRYING', 'temporary');
    expect(row.quotaRefundedAt).toBeNull(); expect(state.ledgers[0].privateReviewsCount).toBe(1);
    await persistReviewFailure('job', 'user', 'FAILED', 'exhausted'); expect(state.ledgers[0].privateReviewsCount).toBe(0);
  });
  it('never refunds an already COMPLETED review or makes a ledger negative', async () => {
    review({ status: 'COMPLETED' }); await markReviewTerminal('job', 'user', 'FAILED', 'late failure');
    expect(state.ledgers[0].privateReviewsCount).toBe(1);
    state.jobs[0].status = 'GENERATING'; state.ledgers[0].privateReviewsCount = 0;
    await markReviewTerminal('job', 'user', 'TIMEOUT', 'timed out'); expect(state.ledgers[0].privateReviewsCount).toBe(0);
  });
  it('rolls back terminal status and refund marker if the ledger write fails', async () => {
    review(); db.usageLedger.updateMany.mockRejectedValueOnce(new Error('ledger unavailable'));
    await expect(markReviewTerminal('job', 'user', 'FAILED', 'failed')).rejects.toThrow('ledger');
    expect(state.jobs[0].status).toBe('GENERATING'); expect(state.jobs[0].quotaRefundedAt).toBeNull();
    await markReviewTerminal('job', 'user', 'FAILED', 'failed'); expect(state.ledgers[0].privateReviewsCount).toBe(0);
  });
});
