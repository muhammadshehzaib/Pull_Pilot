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

  /**
   * Retrieves or initializes the monthly usage ledger for an installation.
   */
  public static async getOrCreateLedger(installationId: string, monthKey: string = this.getCurrentBillingMonth(), tx: Prisma.TransactionClient = prisma) {
    return await tx.usageLedger.upsert({
      where: {
        installationId_billingMonth: {
          installationId,
          billingMonth: monthKey,
        },
      },
      update: {},
      create: {
        installationId,
        billingMonth: monthKey,
        publicReviewsCount: 0,
        privateReviewsCount: 0,
      },
    });
  }

  /**
   * Checks whether a repository analysis is permitted under the installation's plan quota.
   */
  public static async checkQuota(
    installationId: string | null | undefined,
    isPrivate: boolean
  ): Promise<QuotaCheckResult> {
    const currentMonth = this.getCurrentBillingMonth();

    // If no installation linked (e.g. legacy single-user mode), allow by default
    if (!installationId) {
      return {
        allowed: true,
        usage: {
          current: 0,
          limit: null,
          isPrivate,
          tier: 'FREE',
          billingMonth: currentMonth,
        },
      };
    }

    const installation = await prisma.installation.findUnique({
      where: { id: installationId },
    });

    const tier = installation?.plan || 'FREE';

    // 1. Public repositories have unlimited scans on all tiers
    if (!isPrivate) {
      const ledger = await this.getOrCreateLedger(installationId, currentMonth);
      return {
        allowed: true,
        usage: {
          current: ledger.publicReviewsCount,
          limit: null,
          isPrivate: false,
          tier,
          billingMonth: currentMonth,
        },
      };
    }

    // 2. Paid tiers (INDIE, TEAM) have unlimited private reviews
    if (tier === 'INDIE' || tier === 'TEAM') {
      const ledger = await this.getOrCreateLedger(installationId, currentMonth);
      return {
        allowed: true,
        usage: {
          current: ledger.privateReviewsCount,
          limit: null,
          isPrivate: true,
          tier,
          billingMonth: currentMonth,
        },
      };
    }

    // 3. FREE tier private repos: capped at 50 reviews/month
    const ledger = await this.getOrCreateLedger(installationId, currentMonth);
    const limit = FREE_TIER_PRIVATE_LIMIT;

    if (ledger.privateReviewsCount >= limit) {
      return {
        allowed: false,
        reason: `Monthly free tier quota exceeded (${ledger.privateReviewsCount}/${limit} private reviews used this month).`,
        usage: {
          current: ledger.privateReviewsCount,
          limit,
          isPrivate: true,
          tier: 'FREE',
          billingMonth: currentMonth,
        },
      };
    }

    return {
      allowed: true,
      usage: {
        current: ledger.privateReviewsCount,
        limit,
        isPrivate: true,
        tier: 'FREE',
        billingMonth: currentMonth,
      },
    };
  }

  /** Charge and receipt share the job lock and transaction, including enqueue linkage. */
  public static async reserveReview(
    installationId: string | null | undefined, isPrivate: boolean, userId: string | undefined, jobId: string,
  ): Promise<QuotaCheckResult> {
    return prisma.$transaction(async tx => {
      // Same repository -> job lock order as delivery/completion.
      await tx.$queryRaw`SELECT id FROM repositories WHERE id = (SELECT "repositoryId" FROM analysis_jobs WHERE id = ${jobId}) FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM analysis_jobs WHERE id = ${jobId} FOR UPDATE`;
      const job = await tx.analysisJob.findUnique({ where: { id: jobId }, include: { repository: true } });
      if (!job || !userId || job.repository.userId !== userId || !job.repository.isActive ||
          (job.repository.installationId ?? null) !== (installationId ?? null) ||
          !['QUEUED', 'FETCHING', 'ANALYZING', 'GENERATING', 'POSTING', 'RUNNING', 'RETRYING'].includes(job.status)) {
        throw new Error('Review is unavailable for quota reservation');
      }
      if (job.quotaLedgerId) {
        if (job.quotaRefundedAt || job.quotaIsPrivate !== isPrivate) throw new Error('Review reservation is no longer available');
        const ledger = await tx.usageLedger.findUniqueOrThrow({ where: { id: job.quotaLedgerId } });
        const installation = installationId ? await tx.installation.findUnique({ where: { id: installationId } }) : null;
        const subscription = !installationId ? await EntitlementService.getSubscription(userId, tx) : null;
        const tier = installation?.plan || subscription?.plan || 'FREE';
        return { allowed: true, usage: { current: isPrivate ? ledger.privateReviewsCount : ledger.publicReviewsCount,
          limit: isPrivate && tier === 'FREE' ? FREE_TIER_PRIVATE_LIMIT : null, tier, isPrivate, billingMonth: ledger.billingMonth } };
      }
      const result = await this.reserveWithin(tx, installationId, isPrivate, userId);
      if (result.allowed) {
        const ledger = await tx.usageLedger.findUniqueOrThrow({ where: installationId
          ? { installationId_billingMonth: { installationId, billingMonth: result.usage.billingMonth } }
          : { userId_billingMonth: { userId, billingMonth: result.usage.billingMonth } } });
        await tx.analysisJob.update({ where: { id: jobId }, data: {
          quotaLedgerId: ledger.id, quotaIsPrivate: isPrivate, queueJobId: jobId,
        } });
      }
      return result;
    });
  }

  private static async reserveWithin(
    tx: Prisma.TransactionClient,
    installationId: string | null | undefined,
    isPrivate: boolean,
    userId?: string,
  ): Promise<QuotaCheckResult> {
    const billingMonth = this.getCurrentBillingMonth();
    const installation = installationId
      ? await tx.installation.findUnique({ where: { id: installationId } })
      : null;
    const activeSubscription = !installationId && userId
      ? await EntitlementService.getSubscription(userId, tx)
      : null;
    const tier = installation?.plan || activeSubscription?.plan || 'FREE';
    const limit = isPrivate && tier === 'FREE' ? FREE_TIER_PRIVATE_LIMIT : null;
    if (!installationId && !userId) {
      return {
        allowed: false,
        reason: 'A usage owner is required to reserve a review.',
        usage: { current: 0, limit, isPrivate, tier, billingMonth },
      };
    }

    if (installationId) {
      await this.getOrCreateLedger(installationId, billingMonth, tx);
    } else {
      await tx.usageLedger.upsert({
        where: { userId_billingMonth: { userId: userId!, billingMonth } },
        update: {},
        create: { userId: userId!, billingMonth, publicReviewsCount: 0, privateReviewsCount: 0 },
      });
    }

    if (limit !== null) {
      const reserved = await tx.usageLedger.updateMany({
        where: {
          ...(installationId ? { installationId } : { userId }),
          billingMonth,
          privateReviewsCount: { lt: limit },
        },
        data: { privateReviewsCount: { increment: 1 } },
      });
      const ledger = installationId
        ? await this.getOrCreateLedger(installationId, billingMonth, tx)
        : await tx.usageLedger.findUniqueOrThrow({
            where: { userId_billingMonth: { userId: userId!, billingMonth } },
          });
      if (reserved.count === 0) {
        return {
          allowed: false,
          reason: `Monthly free tier quota exceeded (${ledger.privateReviewsCount}/${limit} private reviews used this month).`,
          usage: { current: ledger.privateReviewsCount, limit, isPrivate: true, tier: 'FREE', billingMonth },
        };
      }
      return {
        allowed: true,
        usage: { current: ledger.privateReviewsCount, limit, isPrivate: true, tier, billingMonth },
      };
    }

    const field = isPrivate ? 'privateReviewsCount' : 'publicReviewsCount';
    const updated = await tx.usageLedger.update({
      where: installationId
        ? { installationId_billingMonth: { installationId, billingMonth } }
        : { userId_billingMonth: { userId: userId!, billingMonth } },
      data: { [field]: { increment: 1 } },
    });
    return {
      allowed: true,
      usage: {
        current: isPrivate ? updated.privateReviewsCount : updated.publicReviewsCount,
        limit: null,
        isPrivate,
        tier,
        billingMonth,
      },
    };
  }

  /**
   * Atomically increments the review usage counter upon job completion.
   */
  public static async incrementUsage(installationId: string | null | undefined, isPrivate: boolean): Promise<void> {
    if (!installationId) return;

    const currentMonth = this.getCurrentBillingMonth();

    try {
      if (isPrivate) {
        await prisma.usageLedger.upsert({
          where: {
            installationId_billingMonth: {
              installationId,
              billingMonth: currentMonth,
            },
          },
          update: { privateReviewsCount: { increment: 1 } },
          create: {
            installationId,
            billingMonth: currentMonth,
            publicReviewsCount: 0,
            privateReviewsCount: 1,
          },
        });
      } else {
        await prisma.usageLedger.upsert({
          where: {
            installationId_billingMonth: {
              installationId,
              billingMonth: currentMonth,
            },
          },
          update: { publicReviewsCount: { increment: 1 } },
          create: {
            installationId,
            billingMonth: currentMonth,
            publicReviewsCount: 1,
            privateReviewsCount: 0,
          },
        });
      }
    } catch (err) {
      console.error('Failed to increment usage ledger:', err);
    }
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
