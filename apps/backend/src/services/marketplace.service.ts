import prisma from '../config/prisma';
import { PlanTier } from '@prisma/client';
import { QuotaService } from './quota.service';

export interface MarketplaceAccount {
  type: 'User' | 'Organization';
  id: number;
  login: string;
  organization_billing_email?: string;
}

export interface MarketplacePlan {
  id: number;
  name: string;
  description?: string;
  monthly_price_in_cents?: number;
  yearly_price_in_cents?: number;
  price_model?: 'FREE' | 'FLAT_RATE' | 'PER_UNIT';
}

export interface MarketplacePurchasePayload {
  action: 'purchased' | 'changed' | 'cancelled' | 'pending_change' | 'pending_change_cancelled';
  effective_date?: string;
  marketplace_purchase: {
    account: MarketplaceAccount;
    billing_cycle: 'monthly' | 'yearly';
    unit_count: number;
    on_free_trial: boolean;
    free_trial_ends_on?: string | null;
    next_billing_date?: string | null;
    plan: MarketplacePlan;
  };
  previous_marketplace_purchase?: {
    plan: MarketplacePlan;
    unit_count: number;
    billing_cycle: string;
  };
}

export interface BillingPlanInfo {
  id: PlanTier;
  name: string;
  priceMonthly: number;
  priceYearly?: number;
  description: string;
  features: string[];
}

export const AVAILABLE_PLANS: BillingPlanInfo[] = [
  {
    id: 'FREE',
    name: 'Free Plan',
    priceMonthly: 0,
    description: 'Perfect for open-source contributors and individual side projects.',
    features: [
      'Your own AI key — 0% markup, paid directly by you to the provider',
      'Unlimited reviews on Public Repositories',
      '50 reviews / month on 1 Private Repository',
      '.aipr.yml repository configuration',
    ],
  },
  {
    id: 'INDIE',
    name: 'Indie Plan',
    priceMonthly: 2,
    priceYearly: 10,
    description: 'Unlimited AI reviews for solo professional developers. Platform fee only.',
    features: [
      'Bring your own AI key — zero markup, your provider bills you directly',
      'Unlimited reviews on Public & Private Repositories',
      'Full .aipr.yml customization & severity thresholds',
      'High-priority background queue processing',
      'Multi-model AI switching (Gemini, Claude, GPT, Grok)',
    ],
  },
  {
    id: 'TEAM',
    name: 'Team Plan',
    priceMonthly: 8,
    priceYearly: 100,
    description: 'Collaborative AI review workflows for teams and organizations.',
    features: [
      'Everything in Indie Plan',
      'Organization-wide GitHub App installation',
      'Multiple repository seat pooling',
      'Centralized team AI keys',
    ],
  },
];

export class MarketplaceService {
  /**
   * Maps a GitHub Marketplace plan name to internal PlanTier enum.
   */
  public static mapPlanNameToTier(planName?: string | null): PlanTier {
    if (!planName) return 'FREE';

    const normalized = planName.toLowerCase().trim();

    if (
      normalized.includes('team') ||
      normalized.includes('org') ||
      normalized.includes('business') ||
      normalized.includes('enterprise')
    ) {
      return 'TEAM';
    }

    if (
      normalized.includes('indie') ||
      normalized.includes('pro') ||
      normalized.includes('solo') ||
      normalized.includes('developer')
    ) {
      return 'INDIE';
    }

    return 'FREE';
  }

  /**
   * Handles inbound marketplace_purchase webhook events from GitHub.
   */
  public static async handleMarketplaceEvent(
    payload: MarketplacePurchasePayload
  ): Promise<{ status: string; plan: PlanTier }> {
    const action = payload.action;
    const mpData = payload.marketplace_purchase;

    if (!mpData || !mpData.account || !mpData.plan) {
      throw new Error('Invalid marketplace purchase payload structure');
    }

    const account = mpData.account;
    const plan = mpData.plan;
    const tier = this.mapPlanNameToTier(plan.name);
    const githubInstallationId = BigInt(account.id);
    const nextBillingDate = mpData.next_billing_date ? new Date(mpData.next_billing_date) : null;

    console.log(
      `💳 Processing GitHub Marketplace Event [${action}]: ${account.login} -> Plan: ${plan.name} (${tier})`
    );

    if (action === 'purchased' || action === 'changed') {
      await prisma.installation.upsert({
        where: { githubInstallationId },
        update: {
          accountLogin: account.login,
          accountType: account.type,
          plan: tier,
          marketplacePlanId: BigInt(plan.id),
          marketplacePlanName: plan.name,
          marketplaceUnitCount: mpData.unit_count || 1,
          marketplaceStatus: 'ACTIVE',
          billingCycle: mpData.billing_cycle || 'monthly',
          nextBillingDate,
        },
        create: {
          githubInstallationId,
          accountLogin: account.login,
          accountType: account.type,
          plan: tier,
          marketplacePlanId: BigInt(plan.id),
          marketplacePlanName: plan.name,
          marketplaceUnitCount: mpData.unit_count || 1,
          marketplaceStatus: 'ACTIVE',
          billingCycle: mpData.billing_cycle || 'monthly',
          nextBillingDate,
        },
      });

      console.log(`✅ Updated installation subscription for ${account.login} to ${tier}`);
      return { status: 'ACTIVE', plan: tier };
    }

    if (action === 'cancelled') {
      await prisma.installation.updateMany({
        where: { githubInstallationId },
        data: {
          plan: 'FREE',
          marketplaceStatus: 'CANCELLED',
        },
      });

      console.log(`⚠️ Subscription cancelled for ${account.login}. Reverted to FREE tier.`);
      return { status: 'CANCELLED', plan: 'FREE' };
    }

    if (action === 'pending_change') {
      await prisma.installation.updateMany({
        where: { githubInstallationId },
        data: {
          marketplaceStatus: 'PENDING_CHANGE',
          nextBillingDate,
        },
      });

      return { status: 'PENDING_CHANGE', plan: tier };
    }

    return { status: 'IGNORED', plan: tier };
  }

  /**
   * Returns a comprehensive billing & usage overview for an authenticated user.
   */
  public static async getUserBillingOverview(userId: string) {
    const installations = await prisma.installation.findMany({
      where: { userId },
      include: {
        repositories: { select: { id: true, fullName: true, isPrivate: true, isActive: true } },
      },
    });

    const currentMonth = QuotaService.getCurrentBillingMonth();

    const activeInstallation = installations[0] || null;
    const plan: PlanTier = activeInstallation?.plan || 'FREE';

    let totalPublicReviews = 0;
    let totalPrivateReviews = 0;

    if (activeInstallation) {
      const ledger = await QuotaService.getOrCreateLedger(activeInstallation.id, currentMonth);
      totalPublicReviews = ledger.publicReviewsCount;
      totalPrivateReviews = ledger.privateReviewsCount;
    }

    const privateReviewLimit = plan === 'FREE' ? 50 : null;
    const privateReviewsRemaining =
      privateReviewLimit !== null ? Math.max(0, privateReviewLimit - totalPrivateReviews) : null;

    return {
      plan,
      billingCycle: activeInstallation?.billingCycle || 'monthly',
      marketplaceStatus: activeInstallation?.marketplaceStatus || 'ACTIVE',
      nextBillingDate: activeInstallation?.nextBillingDate || null,
      marketplaceUrl: 'https://github.com/marketplace/ai-pr-reviewer',
      usage: {
        billingMonth: currentMonth,
        publicReviewsUsed: totalPublicReviews,
        privateReviewsUsed: totalPrivateReviews,
        privateReviewLimit,
        privateReviewsRemaining,
        isLimitReached: privateReviewLimit !== null && totalPrivateReviews >= privateReviewLimit,
      },
      availablePlans: AVAILABLE_PLANS,
    };
  }
}
