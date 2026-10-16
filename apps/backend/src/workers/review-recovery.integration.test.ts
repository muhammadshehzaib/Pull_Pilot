import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.mock('../config/socket', () => ({ SocketService: { emitStatus: vi.fn() } }));
vi.mock('../config/queue', () => ({ analysisQueue: {
  getJob: vi.fn(async () => undefined), getJobs: vi.fn(async () => []), getJobCounts: vi.fn(async () => ({})),
} }));

const url = process.env.RECOVERY_TEST_DATABASE_URL;
describe.skipIf(!url)('review recovery and quota transactions on PostgreSQL', () => {
  let db: typeof import('../config/prisma').default;
  let quota: typeof import('../services/quota.service').QuotaService;
  let terminal: typeof import('./job-state').markReviewTerminal;
  let recover: typeof import('./review-recovery').recoverReviewsOnce;
  const userId = randomUUID();
  let installationId: string, repositoryId: string;
  beforeAll(async () => {
    const target = new URL(url!);
    if (!['localhost', '127.0.0.1'].includes(target.hostname) || !target.pathname.endsWith('_test') || process.env.DATABASE_URL !== url) {
      throw new Error('Recovery integration tests require an explicitly selected local disposable *_test database');
    }
    db = (await import('../config/prisma')).default;
    quota = (await import('../services/quota.service')).QuotaService;
    terminal = (await import('./job-state')).markReviewTerminal;
    recover = (await import('./review-recovery')).recoverReviewsOnce;
    await db.user.create({ data: { id: userId, githubId: userId, username: 'recovery-test' } });
    installationId = (await db.installation.create({ data: { userId, githubInstallationId: BigInt(Date.now()), accountLogin: 'recovery-test' } })).id;
    repositoryId = (await db.repository.create({ data: { userId, installationId, githubRepoId: BigInt(Date.now()), fullName: 'recovery/test', isPrivate: true } })).id;
  });
  afterAll(async () => {
    if (!db) return;
    await db.user.delete({ where: { id: userId } });
    await db.usageLedger.deleteMany({ where: { installationId } });
    await db.installation.delete({ where: { id: installationId } });
    await db.$disconnect();
  });
  async function review() {
    return db.analysisJob.create({ data: { repositoryId, eventType: 'PUSH', referenceId: randomUUID() } });
  }
  async function ledgerFor(jobId: string) {
    const job = await db.analysisJob.findUniqueOrThrow({ where: { id: jobId } });
    return db.usageLedger.findUniqueOrThrow({ where: { id: job.quotaLedgerId! } });
  }

  it('serializes concurrent reservations and refunds one original charge', async () => {
    const job = await review();
    const reservations = await Promise.all([quota.reserveReview(installationId, true, userId, job.id), quota.reserveReview(installationId, true, userId, job.id)]);
    expect(reservations.every(r => r.allowed)).toBe(true);
    const before = await ledgerFor(job.id);
    const terminalized = await Promise.all([terminal(job.id, userId, 'FAILED', 'exhausted'), terminal(job.id, userId, 'CANCELLED', 'cancelled')]);
    expect(terminalized.filter(Boolean)).toHaveLength(1);
    expect((await ledgerFor(job.id)).privateReviewsCount).toBe(before.privateReviewsCount - 1);
    expect((await db.analysisJob.findUniqueOrThrow({ where: { id: job.id } })).quotaRefundedAt).not.toBeNull();
  });
  it('returns the quota to the saved ledger even when its billing month has changed', async () => {
    const job = await review(); await quota.reserveReview(installationId, true, userId, job.id);
    const original = await db.usageLedger.create({ data: { installationId, billingMonth: '2000-01', privateReviewsCount: 1 } });
    const current = await ledgerFor(job.id);
    await db.analysisJob.update({ where: { id: job.id }, data: { quotaLedgerId: original.id } });
    await terminal(job.id, userId, 'TIMEOUT', 'timed out');
    expect((await db.usageLedger.findUniqueOrThrow({ where: { id: original.id } })).privateReviewsCount).toBe(0);
    expect((await db.usageLedger.findUniqueOrThrow({ where: { id: current.id } })).privateReviewsCount).toBe(current.privateReviewsCount);
  });
  it('refuses refunds for completed reviews and stale recovery snapshots', async () => {
    const job = await review(); await quota.reserveReview(installationId, true, userId, job.id);
    const stale = await db.analysisJob.findUniqueOrThrow({ where: { id: job.id } });
    await db.analysisJob.update({ where: { id: job.id }, data: { status: 'COMPLETED' } });
    expect(await terminal(job.id, userId, 'FAILED', 'stale failure', {}, stale)).toBe(false);
    expect((await db.analysisJob.findUniqueOrThrow({ where: { id: job.id } })).quotaRefundedAt).toBeNull();
  });
  it('recovers the reserved-but-never-enqueued crash window', async () => {
    const job = await review(); await quota.reserveReview(installationId, true, userId, job.id);
    const { ABANDONED_REVIEW_GRACE_MS } = await import('./review-recovery');
    await db.analysisJob.update({ where: { id: job.id }, data: { updatedAt: new Date(Date.now() - ABANDONED_REVIEW_GRACE_MS - 1000) } });
    await recover();
    const saved = await db.analysisJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(saved.status).toBe('FAILED'); expect(saved.quotaRefundedAt).not.toBeNull();
  });
  it('rolls back status, refund marker and decrement if the transaction fails', async () => {
    const job = await review(); await quota.reserveReview(installationId, true, userId, job.id);
    const ledger = await ledgerFor(job.id);
    const { refundReviewQuota } = await import('../services/review-quota');
    await expect(db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM analysis_jobs WHERE id = ${job.id} FOR UPDATE`;
      const saved = await tx.analysisJob.findUniqueOrThrow({ where: { id: job.id } });
      await tx.analysisJob.update({ where: { id: job.id }, data: { status: 'FAILED' } });
      await refundReviewQuota(tx, saved);
      throw new Error('simulated transaction failure after refund');
    })).rejects.toThrow('simulated transaction failure');
    const saved = await db.analysisJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(saved.status).toBe('QUEUED'); expect(saved.quotaRefundedAt).toBeNull();
    expect((await ledgerFor(job.id)).privateReviewsCount).toBe(ledger.privateReviewsCount);
  });
});
