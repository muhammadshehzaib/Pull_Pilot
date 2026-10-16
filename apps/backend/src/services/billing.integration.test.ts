import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

const url = process.env.RECOVERY_TEST_DATABASE_URL;
describe.skipIf(!url)('billing ordering and checkout locks on PostgreSQL', () => {
  let db: typeof import('../config/prisma').default;
  let billing: typeof import('./billing.service').BillingService;
  const userId = randomUUID();
  const oldProduct = process.env.POLAR_PRODUCT_TEAM_MONTHLY;
  beforeAll(async () => {
    const target = new URL(url!);
    if (!['localhost', '127.0.0.1'].includes(target.hostname) || !target.pathname.endsWith('_test') || process.env.DATABASE_URL !== url) {
      throw new Error('Billing integration tests require an explicitly selected local disposable *_test database');
    }
    db = (await import('../config/prisma')).default;
    billing = (await import('./billing.service')).BillingService;
    process.env.POLAR_PRODUCT_TEAM_MONTHLY = 'billing-test-product';
    await db.user.create({ data: { id: userId, githubId: userId, username: 'billing-test' } });
  });
  afterAll(async () => {
    billing?.setClientForTesting(null);
    if (oldProduct === undefined) delete process.env.POLAR_PRODUCT_TEAM_MONTHLY;
    else process.env.POLAR_PRODUCT_TEAM_MONTHLY = oldProduct;
    if (!db) return;
    await db.installation.deleteMany({ where: { userId } });
    await db.user.delete({ where: { id: userId } });
    await db.$disconnect();
  });
  it('serializes account changes and keeps the newest event across concurrent deliveries', async () => {
    const sub = { id: randomUUID(), product_id: 'billing-test-product', customer: { external_id: userId } };
    await db.installation.create({ data: { userId, githubInstallationId: BigInt(Date.now()), accountLogin: 'billing-test' } });
    await Promise.all([
      billing.syncSubscription({ ...sub, status: 'active' }, '2026-10-17T10:00:00Z'),
      billing.syncCancellation(sub, '2026-10-17T11:00:00Z'),
    ]);
    expect((await db.subscription.findUniqueOrThrow({ where: { polarSubscriptionId: sub.id } })).status).toBe('canceled');
    expect((await db.installation.findFirstOrThrow({ where: { userId } })).plan).toBe('FREE');
    await billing.syncSubscription({ ...sub, status: 'active' }, '2026-10-17T09:00:00Z');
    expect((await db.installation.findFirstOrThrow({ where: { userId } })).plan).toBe('FREE');
  });
  it('persists and reuses one checkout across concurrent API requests', async () => {
    const create = vi.fn(async () => ({ id: randomUUID(), url: 'https://polar.sh/checkout/test' }));
    billing.setClientForTesting({ checkouts: { create, get: vi.fn(async () => ({ status: 'open', url: 'https://polar.sh/checkout/test' })) },
      subscriptions: { list: vi.fn(async () => ({ items: [] })) } } as any);
    const input = { userId, tier: 'TEAM' as const, billingCycle: 'monthly' as const };
    const results = await Promise.all([billing.createCheckout(input), billing.createCheckout(input)]);
    expect(results[0]).toEqual(results[1]); expect(create).toHaveBeenCalledOnce();
    expect(await db.billingCheckout.count({ where: { userId } })).toBe(1);
  });
});
