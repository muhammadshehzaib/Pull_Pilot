import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import prisma from '../config/prisma';
import { QuotaService } from './quota.service';
import { BillingService, BillingConfigurationError, AVAILABLE_PLANS } from './billing.service';

vi.mock('../config/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    installation: { findMany: vi.fn(), updateMany: vi.fn() },
    subscription: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('./quota.service', () => ({
  QuotaService: {
    getCurrentBillingMonth: vi.fn(() => '2026-10'),
    getOrCreateLedger: vi.fn(),
  },
}));

vi.mock('@polar-sh/sdk/2026-10', () => ({
  createPolar: vi.fn(() => ({ checkouts: { create: vi.fn() } })),
  webhooks: { validateEvent: vi.fn() },
}));

const db = prisma as unknown as {
  user: { findUnique: ReturnType<typeof vi.fn> };
  installation: { findMany: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  subscription: {
    upsert: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
};

const quota = QuotaService as unknown as {
  getCurrentBillingMonth: ReturnType<typeof vi.fn>;
  getOrCreateLedger: ReturnType<typeof vi.fn>;
};

const ENV_KEYS = [
  'POLAR_ACCESS_TOKEN',
  'POLAR_WEBHOOK_SECRET',
  'POLAR_SANDBOX',
  'POLAR_PRODUCT_INDIE_MONTHLY',
  'POLAR_PRODUCT_INDIE_YEARLY',
  'POLAR_PRODUCT_TEAM_MONTHLY',
  'POLAR_PRODUCT_TEAM_YEARLY',
  'FRONTEND_URL',
];

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  BillingService.setClientForTesting(null);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  BillingService.setClientForTesting(null);
});

describe('AVAILABLE_PLANS', () => {
  it('uses the agreed BYOK prices', () => {
    const byId = Object.fromEntries(AVAILABLE_PLANS.map((p) => [p.id, p]));
    expect(byId.FREE.priceMonthly).toBe(0);
    expect(byId.INDIE.priceMonthly).toBe(2);
    expect(byId.INDIE.priceYearly).toBe(10);
    expect(byId.TEAM.priceMonthly).toBe(5);
    expect(byId.TEAM.priceYearly).toBe(50);
  });
});

describe('BillingService.resolveTierForProduct', () => {
  it('maps configured product ids to their tier', () => {
    process.env.POLAR_PRODUCT_INDIE_MONTHLY = 'prod_indie_m';
    process.env.POLAR_PRODUCT_INDIE_YEARLY = 'prod_indie_y';
    process.env.POLAR_PRODUCT_TEAM_MONTHLY = 'prod_team_m';

    expect(BillingService.resolveTierForProduct('prod_indie_m')).toBe('INDIE');
    expect(BillingService.resolveTierForProduct('prod_indie_y')).toBe('INDIE');
    expect(BillingService.resolveTierForProduct('prod_team_m')).toBe('TEAM');
  });

  it('returns null for unknown or missing product ids', () => {
    expect(BillingService.resolveTierForProduct('prod_unknown')).toBeNull();
    expect(BillingService.resolveTierForProduct(null)).toBeNull();
    expect(BillingService.resolveTierForProduct(undefined)).toBeNull();
  });
});

describe('BillingService.cycleForSubscription', () => {
  it('reads the recurring interval from price or prices', () => {
    expect(BillingService.cycleForSubscription({ id: 's', price: { recurring_interval: 'year' } })).toBe('yearly');
    expect(BillingService.cycleForSubscription({ id: 's', prices: [{ recurring_interval: 'year' }] })).toBe('yearly');
    expect(BillingService.cycleForSubscription({ id: 's', price: { recurring_interval: 'month' } })).toBe('monthly');
    expect(BillingService.cycleForSubscription({ id: 's' })).toBe('monthly');
  });
});

describe('BillingService.isEntitlingStatus', () => {
  it('treats active, past_due and trialing as entitling', () => {
    expect(BillingService.isEntitlingStatus('active')).toBe(true);
    expect(BillingService.isEntitlingStatus('PAST_DUE')).toBe(true);
    expect(BillingService.isEntitlingStatus('trialing')).toBe(true);
  });

  it('does not entitle canceled, incomplete, unpaid or paused', () => {
    expect(BillingService.isEntitlingStatus('canceled')).toBe(false);
    expect(BillingService.isEntitlingStatus('incomplete')).toBe(false);
    expect(BillingService.isEntitlingStatus('unpaid')).toBe(false);
    expect(BillingService.isEntitlingStatus('paused')).toBe(false);
    expect(BillingService.isEntitlingStatus(null)).toBe(false);
  });
});

describe('BillingService.createCheckout', () => {
  it('throws a configuration error when no access token is set', async () => {
    await expect(
      BillingService.createCheckout({
        userId: 'u1',
        tier: 'INDIE',
        billingCycle: 'monthly',
      }),
    ).rejects.toBeInstanceOf(BillingConfigurationError);
  });

  it('throws when the selected product is not configured', async () => {
    process.env.POLAR_ACCESS_TOKEN = 'tok';
    await expect(
      BillingService.createCheckout({ userId: 'u1', tier: 'TEAM', billingCycle: 'yearly' }),
    ).rejects.toBeInstanceOf(BillingConfigurationError);
  });

  it('passes the product and external customer id to Polar', async () => {
    process.env.POLAR_ACCESS_TOKEN = 'tok';
    process.env.POLAR_PRODUCT_INDIE_YEARLY = 'prod_indie_y';
    process.env.FRONTEND_URL = 'https://app.example.com';

    const create = vi.fn().mockResolvedValue({ url: 'https://polar.sh/checkout/xyz' });
    BillingService.setClientForTesting({ checkouts: { create } } as any);

    const result = await BillingService.createCheckout({
      userId: 'user-123',
      username: 'octocat',
      email: 'octocat@github.com',
      tier: 'INDIE',
      billingCycle: 'yearly',
    });

    expect(result).toEqual({ url: 'https://polar.sh/checkout/xyz' });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        products: ['prod_indie_y'],
        external_customer_id: 'user-123',
        customer_email: 'octocat@github.com',
        customer_name: 'octocat',
        success_url: 'https://app.example.com/dashboard?checkout=success&tier=INDIE',
        return_url: 'https://app.example.com/pricing',
      }),
    );
  });
});

describe('BillingService.getWebhookSecret', () => {
  it('throws when the webhook secret is missing', () => {
    expect(() => BillingService.getWebhookSecret()).toThrow(BillingConfigurationError);
  });

  it('returns the configured webhook secret', () => {
    process.env.POLAR_WEBHOOK_SECRET = 'whsec_123';
    expect(BillingService.getWebhookSecret()).toBe('whsec_123');
  });
});

describe('BillingService.syncSubscription', () => {
  beforeEach(() => {
    process.env.POLAR_PRODUCT_INDIE_MONTHLY = 'prod_indie_m';
  });

  it('does nothing when the customer has no external id', async () => {
    const result = await BillingService.syncSubscription({ id: 'sub_1', status: 'active' });
    expect(result).toEqual({ userId: null, tier: 'FREE' });
    expect(db.subscription.upsert).not.toHaveBeenCalled();
  });

  it('grants the subscribed tier and mirrors it onto installations', async () => {
    db.subscription.upsert.mockResolvedValueOnce({});
    db.subscription.findFirst.mockResolvedValueOnce({ plan: 'INDIE', status: 'active' });
    db.installation.updateMany.mockResolvedValueOnce({ count: 2 });

    const result = await BillingService.syncSubscription({
      id: 'sub_1',
      status: 'active',
      product_id: 'prod_indie_m',
      current_period_end: '2026-11-04T00:00:00.000Z',
      cancel_at_period_end: false,
      customer: { id: 'cus_1', external_id: 'user-123' },
    });

    expect(result).toEqual({ userId: 'user-123', tier: 'INDIE' });
    expect(db.subscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { polarSubscriptionId: 'sub_1' },
        create: expect.objectContaining({
          userId: 'user-123',
          polarCustomerId: 'cus_1',
          plan: 'INDIE',
          status: 'active',
          billingCycle: 'monthly',
        }),
      }),
    );
    expect(db.installation.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-123' },
      data: { plan: 'INDIE' },
    });
  });

  it('downgrades to FREE when the status is not entitling', async () => {
    db.subscription.upsert.mockResolvedValueOnce({});
    db.subscription.findFirst.mockResolvedValueOnce(null);
    db.installation.updateMany.mockResolvedValueOnce({ count: 1 });

    const result = await BillingService.syncSubscription({
      id: 'sub_1',
      status: 'canceled',
      product_id: 'prod_indie_m',
      customer: { id: 'cus_1', external_id: 'user-123' },
    });

    expect(result.tier).toBe('FREE');
    expect(db.subscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ plan: 'FREE' }) }),
    );
    expect(db.installation.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-123' },
      data: { plan: 'FREE' },
    });
  });

  it('never grants access for an unrecognised product', async () => {
    db.subscription.upsert.mockResolvedValueOnce({});
    db.subscription.findFirst.mockResolvedValueOnce(null);
    db.installation.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await BillingService.syncSubscription({
      id: 'sub_1',
      status: 'active',
      product_id: 'prod_something_else',
      customer: { external_id: 'user-123' },
    });

    expect(result.tier).toBe('FREE');
  });
});

describe('BillingService.syncCancellation', () => {
  it('returns null for an unknown subscription', async () => {
    db.subscription.findUnique.mockResolvedValueOnce(null);
    const result = await BillingService.syncCancellation({ id: 'sub_missing' });
    expect(result).toEqual({ userId: null });
    expect(db.subscription.update).not.toHaveBeenCalled();
  });

  it('downgrades installations when no other subscription is active', async () => {
    db.subscription.findUnique.mockResolvedValueOnce({ id: 'sub_1', userId: 'user-123' });
    db.subscription.findFirst.mockResolvedValueOnce(null); // no other active sub
    db.subscription.update.mockResolvedValueOnce({});
    db.subscription.findFirst.mockResolvedValueOnce(null); // syncEntitlements lookup
    db.installation.updateMany.mockResolvedValueOnce({ count: 1 });

    const result = await BillingService.syncCancellation({ id: 'sub_1' });

    expect(result).toEqual({ userId: 'user-123' });
    expect(db.subscription.update).toHaveBeenCalledWith({
      where: { id: 'sub_1' },
      data: { status: 'canceled', plan: 'FREE', cancelAtPeriodEnd: false },
    });
    expect(db.installation.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-123' },
      data: { plan: 'FREE' },
    });
  });

  it('keeps existing access when the user has another active subscription', async () => {
    db.subscription.findUnique.mockResolvedValueOnce({ id: 'sub_1', userId: 'user-123' });
    db.subscription.findFirst.mockResolvedValueOnce({ id: 'sub_2', status: 'active' });
    db.subscription.update.mockResolvedValueOnce({});

    const result = await BillingService.syncCancellation({ id: 'sub_1' });

    expect(result).toEqual({ userId: 'user-123' });
    expect(db.installation.updateMany).not.toHaveBeenCalled();
  });
});

describe('BillingService.syncEntitlements', () => {
  it('prefers TEAM over INDIE', async () => {
    db.subscription.findFirst.mockResolvedValueOnce({ plan: 'TEAM', status: 'active' });
    db.installation.updateMany.mockResolvedValueOnce({ count: 1 });

    const tier = await BillingService.syncEntitlements('user-123');
    expect(tier).toBe('TEAM');
    expect(db.installation.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-123' },
      data: { plan: 'TEAM' },
    });
  });

  it('sets FREE when there is no active subscription', async () => {
    db.subscription.findFirst.mockResolvedValueOnce(null);
    db.installation.updateMany.mockResolvedValueOnce({ count: 1 });

    const tier = await BillingService.syncEntitlements('user-123');
    expect(tier).toBe('FREE');
  });
});

describe('BillingService.getUserBillingOverview', () => {
  it('reports FREE with a 50 private review cap when not subscribed', async () => {
    db.installation.findMany.mockResolvedValueOnce([{ id: 'inst_1' }]);
    db.subscription.findFirst.mockResolvedValueOnce(null);
    quota.getOrCreateLedger.mockResolvedValueOnce({
      publicReviewsCount: 3,
      privateReviewsCount: 45,
    });

    const overview = await BillingService.getUserBillingOverview('user-123');

    expect(overview.plan).toBe('FREE');
    expect(overview.subscriptionStatus).toBe('inactive');
    expect(overview.usage.privateReviewLimit).toBe(50);
    expect(overview.usage.privateReviewsRemaining).toBe(5);
    expect(overview.usage.isLimitReached).toBe(false);
  });

  it('reports the paid tier as unlimited when the subscription is active', async () => {
    db.installation.findMany.mockResolvedValueOnce([{ id: 'inst_1' }]);
    db.subscription.findFirst.mockResolvedValueOnce({
      plan: 'INDIE',
      status: 'active',
      billingCycle: 'yearly',
      currentPeriodEnd: new Date('2026-11-04T00:00:00.000Z'),
      cancelAtPeriodEnd: false,
    });
    quota.getOrCreateLedger.mockResolvedValueOnce({
      publicReviewsCount: 10,
      privateReviewsCount: 500,
    });

    const overview = await BillingService.getUserBillingOverview('user-123');

    expect(overview.plan).toBe('INDIE');
    expect(overview.billingCycle).toBe('yearly');
    expect(overview.usage.privateReviewLimit).toBeNull();
    expect(overview.usage.isLimitReached).toBe(false);
  });

  it('treats a canceled subscription as FREE even if the row says INDIE', async () => {
    db.installation.findMany.mockResolvedValueOnce([{ id: 'inst_1' }]);
    db.subscription.findFirst.mockResolvedValueOnce({
      plan: 'INDIE',
      status: 'canceled',
      billingCycle: 'monthly',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    });
    quota.getOrCreateLedger.mockResolvedValueOnce({
      publicReviewsCount: 0,
      privateReviewsCount: 50,
    });

    const overview = await BillingService.getUserBillingOverview('user-123');

    expect(overview.plan).toBe('FREE');
    expect(overview.usage.isLimitReached).toBe(true);
  });
});