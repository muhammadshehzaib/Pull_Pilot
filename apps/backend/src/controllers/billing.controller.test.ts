import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BillingController } from './billing.controller';
import { BillingService, AVAILABLE_PLANS } from '../services/billing.service';
import { mockReq, mockRes } from '../test-utils/express-mocks';

vi.mock('../services/billing.service', () => ({
  BillingConfigurationError: class BillingConfigurationError extends Error {},
  BillingService: {
    getUserBillingOverview: vi.fn(),
    getCheckoutCustomer: vi.fn(),
    createCheckout: vi.fn(),
    validateWebhookEvent: vi.fn(),
    syncSubscription: vi.fn(),
    syncCancellation: vi.fn(),
  },
  AVAILABLE_PLANS: [
    { id: 'FREE', name: 'Free Plan', priceMonthly: 0 },
    { id: 'INDIE', name: 'Indie Plan', priceMonthly: 2, priceYearly: 10 },
    { id: 'TEAM', name: 'Team Plan', priceMonthly: 5, priceYearly: 50 },
  ],
}));

const mocked = BillingService as unknown as {
  getUserBillingOverview: ReturnType<typeof vi.fn>;
  getCheckoutCustomer: ReturnType<typeof vi.fn>;
  createCheckout: ReturnType<typeof vi.fn>;
  validateWebhookEvent: ReturnType<typeof vi.fn>;
  syncSubscription: ReturnType<typeof vi.fn>;
  syncCancellation: ReturnType<typeof vi.fn>;
};

describe('BillingController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getPlans', () => {
    it('returns available plan tiers without leaking Polar product ids', async () => {
      const req = mockReq();
      const res = mockRes();

      await BillingController.getPlans(req, res);

      const payload = (res.json as any).mock.calls[0][0];
      expect(payload).toEqual({
        plans: [
          { id: 'FREE', name: 'Free Plan', priceMonthly: 0 },
          { id: 'INDIE', name: 'Indie Plan', priceMonthly: 2, priceYearly: 10 },
          { id: 'TEAM', name: 'Team Plan', priceMonthly: 5, priceYearly: 50 },
        ],
      });
      expect(JSON.stringify(payload)).not.toContain('productIds');
    });

    it('does not require authentication', async () => {
      const res = mockRes();
      await BillingController.getPlans(mockReq(), res);
      expect(res.status).not.toHaveBeenCalledWith(401);
    });
  });

  describe('getUsage', () => {
    it('returns user billing overview for authenticated user', async () => {
      const fakeOverview = {
        plan: 'FREE',
        usage: {
          publicReviewsUsed: 5,
          privateReviewsUsed: 12,
          privateReviewLimit: 50,
          privateReviewsRemaining: 38,
        },
      };
      mocked.getUserBillingOverview.mockResolvedValueOnce(fakeOverview);

      const req = mockReq({ auth: { userId: 'user-123', githubId: 'gh-456' } as any });
      const res = mockRes();

      await BillingController.getUsage(req, res);

      expect(mocked.getUserBillingOverview).toHaveBeenCalledWith('user-123');
      expect(res.json).toHaveBeenCalledWith(fakeOverview);
    });

    it('returns 500 when service throws an unexpected error', async () => {
      mocked.getUserBillingOverview.mockRejectedValueOnce(new Error('DB failure'));

      const req = mockReq({ auth: { userId: 'user-123', githubId: 'gh-456' } as any });
      const res = mockRes();

      await BillingController.getUsage(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Failed to retrieve billing overview' });
    });
  });

  describe('createCheckout', () => {
    it('rejects an unknown tier', async () => {
      const req = mockReq({
        auth: { userId: 'user-123' } as any,
        body: { tier: 'ENTERPRISE', billingCycle: 'monthly' },
      });
      const res = mockRes();

      await BillingController.createCheckout(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mocked.createCheckout).not.toHaveBeenCalled();
    });

    it('rejects the free tier, which has no checkout', async () => {
      const req = mockReq({
        auth: { userId: 'user-123' } as any,
        body: { tier: 'free', billingCycle: 'monthly' },
      });
      const res = mockRes();

      await BillingController.createCheckout(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mocked.createCheckout).not.toHaveBeenCalled();
    });

    it('rejects an invalid billing cycle', async () => {
      const req = mockReq({
        auth: { userId: 'user-123' } as any,
        body: { tier: 'INDIE', billingCycle: 'weekly' },
      });
      const res = mockRes();

      await BillingController.createCheckout(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'billingCycle must be monthly or yearly',
      });
    });

    it('returns the Polar checkout url', async () => {
      mocked.getCheckoutCustomer.mockResolvedValueOnce({
        username: 'octocat',
        email: 'octocat@github.com',
      });
      mocked.createCheckout.mockResolvedValueOnce({ url: 'https://polar.sh/checkout/abc' });

      const req = mockReq({
        auth: { userId: 'user-123' } as any,
        body: { tier: 'indie', billingCycle: 'yearly' },
      });
      const res = mockRes();

      await BillingController.createCheckout(req, res);

      expect(mocked.createCheckout).toHaveBeenCalledWith({
        userId: 'user-123',
        username: 'octocat',
        email: 'octocat@github.com',
        tier: 'INDIE',
        billingCycle: 'yearly',
      });
      expect(res.json).toHaveBeenCalledWith({ url: 'https://polar.sh/checkout/abc' });
    });

    it('returns 503 when Polar is not configured', async () => {
      const { BillingConfigurationError } = await import('../services/billing.service');
      mocked.getCheckoutCustomer.mockResolvedValueOnce(null);
      mocked.createCheckout.mockRejectedValueOnce(new BillingConfigurationError('no product'));

      const req = mockReq({
        auth: { userId: 'user-123' } as any,
        body: { tier: 'INDIE', billingCycle: 'monthly' },
      });
      const res = mockRes();

      await BillingController.createCheckout(req, res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({ error: 'Billing is not available right now' });
    });

    it('returns 500 when checkout creation fails unexpectedly', async () => {
      mocked.getCheckoutCustomer.mockResolvedValueOnce(null);
      mocked.createCheckout.mockRejectedValueOnce(new Error('polar timeout'));

      const req = mockReq({
        auth: { userId: 'user-123' } as any,
        body: { tier: 'TEAM', billingCycle: 'monthly' },
      });
      const res = mockRes();

      await BillingController.createCheckout(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Failed to start checkout' });
    });
  });

  describe('handleWebhook', () => {
    it('returns 400 when the raw body was not preserved', async () => {
      const res = mockRes();
      await BillingController.handleWebhook(mockReq({ rawBody: undefined }), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mocked.validateWebhookEvent).not.toHaveBeenCalled();
    });

    it('returns 403 when the signature is invalid', async () => {
      mocked.validateWebhookEvent.mockRejectedValueOnce(new Error('bad signature'));

      const req = mockReq({
        rawBody: Buffer.from('{}'),
        headers: { 'webhook-signature': 'nope' },
      });
      const res = mockRes();

      await BillingController.handleWebhook(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(mocked.syncSubscription).not.toHaveBeenCalled();
    });

    it('passes lowercased string headers to the signature validator', async () => {
      mocked.validateWebhookEvent.mockResolvedValueOnce({ type: 'order.created', data: {} });

      const req = mockReq({
        rawBody: Buffer.from('{}'),
        headers: { 'Webhook-Signature': 'abc123', 'x-array': ['a', 'b'] },
      });
      const res = mockRes();

      await BillingController.handleWebhook(req, res);

      expect(mocked.validateWebhookEvent).toHaveBeenCalledWith(Buffer.from('{}'), {
        'webhook-signature': 'abc123',
      });
    });

    it('syncs entitlement on subscription.created', async () => {
      const data = { id: 'sub_1', customer: { external_id: 'user-123' } };
      mocked.validateWebhookEvent.mockResolvedValueOnce({ type: 'subscription.created', timestamp: '2026-10-17T10:00:00Z', data });
      mocked.syncSubscription.mockResolvedValueOnce({ userId: 'user-123', tier: 'INDIE' });

      const req = mockReq({ rawBody: Buffer.from('{}'), headers: {} });
      const res = mockRes();

      await BillingController.handleWebhook(req, res);

      expect(mocked.syncSubscription).toHaveBeenCalledWith(data, '2026-10-17T10:00:00Z');
      expect(res.status).toHaveBeenCalledWith(202);
    });

    it.each(['subscription.revoked'])(
      'revokes access on %s when the user has no other subscription',
      async (type) => {
      mocked.validateWebhookEvent.mockResolvedValueOnce({
        type,
        timestamp: '2026-10-17T10:00:00Z',
        data: { id: 'sub_1' },
      });
      mocked.syncCancellation.mockResolvedValueOnce({ userId: 'user-123' });

      const req = mockReq({ rawBody: Buffer.from('{}'), headers: {} });
      const res = mockRes();

      await BillingController.handleWebhook(req, res);

      expect(mocked.syncCancellation).toHaveBeenCalledWith({ id: 'sub_1' }, '2026-10-17T10:00:00Z');
      expect(res.status).toHaveBeenCalledWith(202);
    });

    it('syncs a scheduled cancellation without forcing immediate revocation', async () => {
      const data = { id: 'sub_1', status: 'active', cancel_at_period_end: true };
      mocked.validateWebhookEvent.mockResolvedValueOnce({ type: 'subscription.canceled', timestamp: '2026-10-17T10:00:00Z', data });
      mocked.syncSubscription.mockResolvedValueOnce({ userId: 'user-123', tier: 'TEAM' });
      const res = mockRes();
      await BillingController.handleWebhook(mockReq({ rawBody: Buffer.from('{}'), headers: {} }), res);
      expect(mocked.syncSubscription).toHaveBeenCalledWith(data, '2026-10-17T10:00:00Z');
      expect(mocked.syncCancellation).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(202);
    });

    it('acknowledges but ignores unrelated event types', async () => {
      mocked.validateWebhookEvent.mockResolvedValueOnce({ type: 'order.paid', data: {} });

      const req = mockReq({ rawBody: Buffer.from('{}'), headers: {} });
      const res = mockRes();

      await BillingController.handleWebhook(req, res);

      expect(mocked.syncSubscription).not.toHaveBeenCalled();
      expect(mocked.syncCancellation).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.json).toHaveBeenCalledWith({ received: true, ignored: 'order.paid' });
    });

    it('returns 500 so Polar retries when persistence fails', async () => {
      mocked.validateWebhookEvent.mockResolvedValueOnce({
        type: 'subscription.active',
        data: { id: 'sub_1' },
      });
      mocked.syncSubscription.mockRejectedValueOnce(new Error('db down'));

      const req = mockReq({ rawBody: Buffer.from('{}'), headers: {} });
      const res = mockRes();

      await BillingController.handleWebhook(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Failed to process event' });
    });
  });
});
