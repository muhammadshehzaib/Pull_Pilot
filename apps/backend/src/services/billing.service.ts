import prisma from '../config/prisma';
import { PlanTier, Prisma } from '@prisma/client';
import { createPolar, webhooks } from '@polar-sh/sdk/2026-10';
import { QuotaService } from './quota.service';
import { EntitlementService } from './entitlement.service';

export type BillingCycle = 'monthly' | 'yearly';
export type PaidTier = Exclude<PlanTier, 'FREE'>;

type PolarClient = ReturnType<typeof createPolar>;

/**
 * The slice of a Polar `Subscription` we care about. Narrower than the SDK type
 * on purpose: it keeps the service testable with plain objects and stops a
 * Polar API rename from breaking the webhook path.
 */
export interface PolarSubscriptionLike {
  id: string;
  status?: string | null;
  product_id?: string | null;
  current_period_end?: string | Date | null;
  cancel_at_period_end?: boolean | null;
  customer?: { id?: string | null; external_id?: string | null } | null;
  prices?: { recurring_interval?: string | null }[] | null;
  price?: { recurring_interval?: string | null } | null;
}

export interface BillingPlanInfo {
  id: PlanTier;
  name: string;
  /** Display prices only. Polar is the source of truth for what is charged. */
  priceMonthly: number;
  priceYearly?: number;
  description: string;
  features: string[];
}

/**
 * Product ids live in env so a Polar dashboard change never needs a deploy.
 * Read dynamically (not captured at import) so tests can set them per case.
 */
function productEnvKey(tier: PaidTier, cycle: BillingCycle): string {
  return `POLAR_PRODUCT_${tier}_${cycle.toUpperCase()}`;
}

function getProductId(tier: PaidTier, cycle: BillingCycle): string | undefined {
  return process.env[productEnvKey(tier, cycle)] || undefined;
}

/**
 * Subscription statuses that grant a paid tier.
 *
 * `past_due` and `trialing` keep access: a card that fails once should not cut
 * someone off mid-work, and Polar will send `canceled` when it gives up.
 * `incomplete`/`incomplete_expired`/`unpaid`/`paused` do not grant access.
 */
const ENTITLING_STATUSES = new Set(['active', 'past_due', 'trialing']);

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
    priceMonthly: 5,
    priceYearly: 50,
    description: 'Collaborative AI review workflows for teams and organizations.',
    features: [
      'Everything in Indie Plan',
      'Organization-wide GitHub App installation',
      'Multiple repository seat pooling',
      'Centralized team AI keys',
    ],
  },
];

/**
 * Maps every configured Polar product id to its tier. Built per call because the
 * product ids come from env, which tests mutate.
 */
function productIdToTier(): Map<string, PlanTier> {
  const map = new Map<string, PlanTier>();
  for (const tier of ['INDIE', 'TEAM'] as const) {
    for (const cycle of ['monthly', 'yearly'] as const) {
      const productId = getProductId(tier, cycle);
      if (productId) map.set(productId, tier);
    }
  }
  return map;
}

export class BillingConfigurationError extends Error {}

export class BillingService {
  private static client: PolarClient | null = null;

  /**
   * Lazily builds the Polar client so tests and local dev without credentials
   * never need a valid access token at import time.
   */
  private static getClient(): PolarClient {
    if (this.client) return this.client;

    const accessToken = process.env.POLAR_ACCESS_TOKEN;
    if (!accessToken) {
      throw new BillingConfigurationError(
        'POLAR_ACCESS_TOKEN is not set — refusing to create a checkout session.',
      );
    }

    this.client = createPolar({
      accessToken,
      environment: process.env.POLAR_SANDBOX === 'true' ? 'sandbox' : 'production',
    });
    return this.client;
  }

  /** Test seam: injects a stub client. Pass null to restore the real one. */
  static setClientForTesting(client: PolarClient | null): void {
    this.client = client;
  }

  static getWebhookSecret(): string {
    const secret = process.env.POLAR_WEBHOOK_SECRET;
    if (!secret) {
      throw new BillingConfigurationError(
        'POLAR_WEBHOOK_SECRET is not set — refusing to process unverified billing events.',
      );
    }
    return secret;
  }

  /**
   * Verifies a Polar webhook signature and returns the parsed event.
   * Throws on an invalid signature so the route can answer 403.
   */
  static validateWebhookEvent(rawBody: Buffer, headers: Record<string, string>) {
    return webhooks.validateEvent(rawBody, headers, this.getWebhookSecret());
  }

  /**
   * Reads the identity fields Polar uses to prefill checkout. Returns null when
   * the account is gone, so checkout can still proceed on the external id.
   */
  static async getCheckoutCustomer(userId: string) {
    return prisma.user.findUnique({
      where: { id: userId },
      select: { username: true, email: true },
    });
  }

  /**
   * Creates a Polar checkout session and returns the URL to redirect to.
   *
   * `external_customer_id` is set to our own user id. That is what lets a
   * webhook payload be traced back to a local account without maintaining a
   * separate customer mapping table.
   */
  static async createCheckout(input: {
    userId: string;
    username?: string | null;
    email?: string | null;
    tier: PaidTier;
    billingCycle: BillingCycle;
  }): Promise<{ url: string }> {
    const productId = getProductId(input.tier, input.billingCycle);

    if (!productId) {
      throw new BillingConfigurationError(
        `No Polar product is configured for ${input.tier} (${input.billingCycle}). ` +
          `Set ${productEnvKey(input.tier, input.billingCycle)}.`,
      );
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    const checkout = await this.getClient().checkouts.create({
      products: [productId],
      external_customer_id: input.userId,
      customer_email: input.email ?? undefined,
      customer_name: input.username ?? undefined,
      success_url: `${frontendUrl}/dashboard?checkout=success&tier=${input.tier}`,
      return_url: `${frontendUrl}/pricing`,
      allow_discount_codes: true,
      // Trials are a per-product decision in Polar; never enable them implicitly.
      allow_trial: false,
    });

    return { url: checkout.url };
  }

  /**
   * Resolves the tier a Polar product id represents, or null for a product we do
   * not recognise so an unrelated purchase can never grant access.
   */
  static resolveTierForProduct(productId?: string | null): PlanTier | null {
    if (!productId) return null;
    return productIdToTier().get(productId) ?? null;
  }

  /**
   * The tier a subscription status entitles the user to, ignoring which product
   * was bought.
   */
  static isEntitlingStatus(status?: string | null): boolean {
    if (!status) return false;
    return ENTITLING_STATUSES.has(status.toLowerCase());
  }

  /** Derives the billing cycle from whichever price shape Polar sends. */
  static cycleForSubscription(subscription: PolarSubscriptionLike): BillingCycle {
    const interval =
      subscription.price?.recurring_interval ??
      subscription.prices?.[0]?.recurring_interval ??
      null;
    return interval === 'year' ? 'yearly' : 'monthly';
  }

  /**
   * Applies a Polar subscription event to local state and re-derives the user's
   * entitlement.
   */
  static async syncSubscription(subscription: PolarSubscriptionLike, eventTimestamp: string | Date): Promise<{
    userId: string | null;
    tier: PlanTier;
  }> {
    const eventAt = new Date(eventTimestamp);
    if (!Number.isFinite(eventAt.getTime())) throw new Error('Invalid billing event timestamp');
    const known = await prisma.subscription.findUnique({ where: { polarSubscriptionId: subscription.id } });
    const userId = known?.userId ?? subscription.customer?.external_id ?? null;
    if (!userId) {
      // Subscriptions created outside our checkout (manual Polar dashboard
      // edits) have no external id. There is nothing to grant against.
      return { userId: null, tier: 'FREE' };
    }

    const status = (subscription.status ?? 'inactive').toLowerCase();
    const productTier = this.resolveTierForProduct(subscription.product_id);
    const tier =
      ENTITLING_STATUSES.has(status) ? (productTier ?? 'FREE') : 'FREE';

    const periodEnd = subscription.current_period_end
      ? new Date(subscription.current_period_end)
      : null;

    return prisma.$transaction(async tx => {
      // All subscription changes for an account share this lock, including
      // entitlement writes to its installations.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      const existing = await tx.subscription.findUnique({ where: { polarSubscriptionId: subscription.id } });
      const sameTimeRevocation = existing?.lastEventAt?.getTime() === eventAt.getTime() &&
        status === 'canceled' && this.isEntitlingStatus(existing.status);
      if (existing?.lastEventAt && existing.lastEventAt >= eventAt && !sameTimeRevocation) {
        return { userId, tier: existing.plan };
      }
      await tx.subscription.upsert({
        where: { polarSubscriptionId: subscription.id },
        update: {
          userId,
          status,
          lastEventAt: eventAt,
          plan: tier,
          billingCycle: this.cycleForSubscription(subscription),
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
          polarCustomerId: subscription.customer?.id ?? undefined,
          polarProductId: subscription.product_id ?? undefined,
        },
        create: {
          userId,
          provider: 'polar',
          polarSubscriptionId: subscription.id,
          polarCustomerId: subscription.customer?.id ?? null,
          polarProductId: subscription.product_id ?? null,
          plan: tier,
          status,
          lastEventAt: eventAt,
          billingCycle: this.cycleForSubscription(subscription),
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
        },
      });

      await this.syncEntitlements(userId, tx);
      return { userId, tier };
    });
  }

  /**
   * Ends a subscription's entitlement. If the user holds another still-active
   * subscription their access is left alone.
   */
  static async syncCancellation(subscription: PolarSubscriptionLike, eventTimestamp: string | Date): Promise<{ userId: string | null }> {
    // Revocations must be persisted even when delivered before the creation
    // event; otherwise a delayed activation can bring revoked access back.
    const { userId } = await this.syncSubscription({ ...subscription, status: 'canceled', cancel_at_period_end: false }, eventTimestamp);
    return { userId };
  }

  /**
   * Mirrors the user's best active tier onto every installation they own.
   *
   * `Installation.plan` is what the quota gate reads. Writing it here keeps one
   * write path for entitlement, so the gate stays a cheap lookup with no extra
   * joins on the hot path.
   */
  static async syncEntitlements(userId: string, tx: Prisma.TransactionClient = prisma): Promise<PlanTier> {
    const active = await EntitlementService.getSubscription(userId, tx);

    const tier: PlanTier =
      active?.plan === 'TEAM' ? 'TEAM' : active?.plan === 'INDIE' ? 'INDIE' : 'FREE';

    await tx.installation.updateMany({
      where: { userId },
      data: { plan: tier },
    });

    return tier;
  }

  /**
   * The caller's plan, subscription state and this month's usage, for
   * GET /api/billing/usage.
   */
  static async getUserBillingOverview(userId: string) {
    const installations = await prisma.installation.findMany({
      where: { userId },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });

    const active = await EntitlementService.getSubscription(userId);
    const subscription = active ?? await prisma.subscription.findFirst({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    });

    const plan: PlanTier = active?.plan ?? 'FREE';

    const currentMonth = QuotaService.getCurrentBillingMonth();

    let totalPublicReviews = 0;
    let totalPrivateReviews = 0;

    const ledgerTotals = await prisma.usageLedger.aggregate({
      where: {
        billingMonth: currentMonth,
        OR: [
          ...(installations.length ? [{ installationId: { in: installations.map((item) => item.id) } }] : []),
          { userId },
        ],
      },
      _sum: { publicReviewsCount: true, privateReviewsCount: true },
    });
    totalPublicReviews = ledgerTotals._sum.publicReviewsCount ?? 0;
    totalPrivateReviews = ledgerTotals._sum.privateReviewsCount ?? 0;

    const privateReviewLimit = plan === 'FREE' ? 50 : null;
    const privateReviewsRemaining =
      privateReviewLimit !== null ? Math.max(0, privateReviewLimit - totalPrivateReviews) : null;

    return {
      plan,
      billingCycle: subscription?.billingCycle || 'monthly',
      subscriptionStatus: subscription?.status || 'inactive',
      currentPeriodEnd: subscription?.currentPeriodEnd || null,
      cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd || false,
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
