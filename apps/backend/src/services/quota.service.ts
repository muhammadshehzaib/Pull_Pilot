import prisma from '../config/prisma';
import type { Prisma } from '@prisma/client';
import { EntitlementService } from './entitlement.service';

export const FREE_TIER_PRIVATE_LIMIT = 50;

export interface QuotaCheckResult {
  allowed: boolean;
  reason?: string;
  usage: {
    current: number;
    limit: number | null; // null represents unlimited
    isPrivate: boolean;
    tier: string;
    billingMonth: string;
  };
}

export class QuotaService {
  /**
   * Returns current billing month key in YYYY-MM format.
   */
  public static getCurrentBillingMonth(date: Date = new Date()): string {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }

  /** Account totals include legacy installation ledgers until migration completes. */
  public static async getAccountUsage(userId: string, billingMonth: string, tx: Prisma.TransactionClient = prisma) {
    const totals = await tx.usageLedger.aggregate({
      where: { billingMonth, OR: [{ userId }, { installation: { userId } }] },
      _sum: { publicReviewsCount: true, privateReviewsCount: true },
    });
    return { publicReviewsCount: totals._sum.publicReviewsCount ?? 0, privateReviewsCount: totals._sum.privateReviewsCount ?? 0 };
  }

  /** Preflight only; reserveReview is the atomic authority for all producers. */
  public static async checkQuota(installationId: string | null | undefined, isPrivate: boolean, userId?: string): Promise<QuotaCheckResult> {
    const billingMonth = this.getCurrentBillingMonth();
    const owner = userId ?? (installationId ? (await prisma.installation.findUnique({ where: { id: installationId } }))?.userId : null);
    const tier = owner ? (await EntitlementService.getSubscription(owner))?.plan ?? 'FREE' : 'FREE';
    const limit = isPrivate && tier === 'FREE' ? FREE_TIER_PRIVATE_LIMIT : null;
    if (!owner) return { allowed: false, reason: 'A usage owner is required to review a repository.',
      usage: { current: 0, limit, isPrivate, tier, billingMonth } };
    const totals = await this.getAccountUsage(owner, billingMonth);
    const current = isPrivate ? totals.privateReviewsCount : totals.publicReviewsCount;
    const allowed = limit === null || current < limit;
    return { allowed, ...(allowed ? {} : { reason: 'Monthly free tier quota exceeded (' + current + '/' + limit + ' private reviews used this month).' }),
      usage: { current, limit, isPrivate, tier, billingMonth } };
  }

  /** Charge and receipt share the job lock and transaction, including enqueue linkage. */
  public static async reserveReview(
    installationId: string | null | undefined, isPrivate: boolean, userId: string | undefined, jobId: string,
  ): Promise<QuotaCheckResult> {
    return prisma.$transaction(async tx => {
      if (!userId) throw new Error('A usage owner is required to reserve a review');
      // Account -> repository -> job: also used by installation linking.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM repositories WHERE id = (SELECT "repositoryId" FROM analysis_jobs WHERE id = ${jobId}) FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM analysis_jobs WHERE id = ${jobId} FOR UPDATE`;
      const job = await tx.analysisJob.findUnique({ where: { id: jobId }, include: { repository: true } });
      if (!job || job.repository.userId !== userId || !job.repository.isActive ||
          (job.repository.installationId ?? null) !== (installationId ?? null) ||
          !['QUEUED', 'FETCHING', 'ANALYZING', 'GENERATING', 'POSTING', 'RUNNING', 'RETRYING'].includes(job.status)) {
        throw new Error('Review is unavailable for quota reservation');
      }
      if (job.quotaLedgerId) {
        if (job.quotaRefundedAt || job.quotaIsPrivate !== isPrivate) throw new Error('Review reservation is no longer available');
        const ledger = await tx.usageLedger.findUniqueOrThrow({ where: { id: job.quotaLedgerId } });
        const tier = (await EntitlementService.getSubscription(userId, tx))?.plan ?? 'FREE';
        const totals = await this.getAccountUsage(userId, ledger.billingMonth, tx);
        return { allowed: true, usage: { current: isPrivate ? totals.privateReviewsCount : totals.publicReviewsCount,
          limit: isPrivate && tier === 'FREE' ? FREE_TIER_PRIVATE_LIMIT : null, tier, isPrivate, billingMonth: ledger.billingMonth } };
      }
      const result = await this.reserveWithin(tx, isPrivate, userId, job.repository.githubRepoId);
      if (result.allowed) {
        const ledger = await tx.usageLedger.findUniqueOrThrow({ where: { userId_billingMonth: { userId, billingMonth: result.usage.billingMonth } } });
        await tx.analysisJob.update({ where: { id: jobId }, data: {
          quotaLedgerId: ledger.id, quotaIsPrivate: isPrivate, queueJobId: jobId,
        } });
      }
      return result;
    });
  }

  private static async reserveWithin(tx: Prisma.TransactionClient, isPrivate: boolean, userId: string, githubRepoId: bigint): Promise<QuotaCheckResult> {
    const billingMonth = this.getCurrentBillingMonth();
    const tier = (await EntitlementService.getSubscription(userId, tx))?.plan ?? 'FREE';
    const limit = isPrivate && tier === 'FREE' ? FREE_TIER_PRIVATE_LIMIT : null;
    const totals = await this.getAccountUsage(userId, billingMonth, tx);
    const current = isPrivate ? totals.privateReviewsCount : totals.publicReviewsCount;
    const usage = { current, limit, isPrivate, tier, billingMonth };
    if (limit !== null) {
      // App installations can import many repositories. Free access covers the
      // earliest connected active private repository, across every connection.
      const eligible = await tx.repository.findFirst({
        where: { userId, isPrivate: true, isActive: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { githubRepoId: true },
      });
      if (!eligible || eligible.githubRepoId !== githubRepoId) {
        return { allowed: false, reason: 'Free plan supports one active private repository. Disconnect the other private repository or upgrade.', usage };
      }
      if (current >= limit) return { allowed: false,
        reason: 'Monthly free tier quota exceeded (' + current + '/' + limit + ' private reviews used this month).', usage };
    }
    await tx.usageLedger.upsert({
      where: { userId_billingMonth: { userId, billingMonth } },
      update: {}, create: { userId, billingMonth, publicReviewsCount: 0, privateReviewsCount: 0 },
    });
    const field = isPrivate ? 'privateReviewsCount' : 'publicReviewsCount';
    await tx.usageLedger.update({ where: { userId_billingMonth: { userId, billingMonth } }, data: { [field]: { increment: 1 } } });
    return { allowed: true, usage: { ...usage, current: current + 1 } };
  }

  /**
   * Generates a markdown notification comment when the free tier quota is reached.
   */
  public static getQuotaExceededComment(usageCount: number, limit: number): string {
    return `### ⚠️ AI PR Reviewer — Free Tier Monthly Limit Reached

This repository is on the **Free Plan** and has used **${usageCount} of ${limit}** private pull request reviews for this billing cycle.

- **Public Repositories**: Free & Unlimited forever.
- **Need more private reviews?** Upgrade to the **Indie Plan** ($2/month or $10/year) for unlimited reviews across all your repositories. You keep paying your AI provider at their own rates — the subscription is platform fee only.

Reviews will automatically resume at the start of next month.`;
  }
}
