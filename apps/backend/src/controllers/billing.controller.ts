import { Request, Response } from 'express';
import {
  AVAILABLE_PLANS,
  BillingConfigurationError,
  BillingService,
  PaidTier,
  PolarSubscriptionLike,
} from '../services/billing.service';
import { CANCEL_EVENTS, PAID_TIERS, SYNC_EVENTS } from '../utils/constants';

export class BillingController {
  /**
   * GET /api/billing/plans
   * Public plan catalog.
   */
  static async getPlans(_req: Request, res: Response) {
    return res.json({ plans: AVAILABLE_PLANS });
  }

  /**
   * GET /api/billing/usage
   * The authenticated user's plan, subscription state and usage.
   */
  static async getUsage(req: Request, res: Response) {
    try {
      const billingOverview = await BillingService.getUserBillingOverview(req.auth!.userId);
      return res.json(billingOverview);
    } catch (err) {
      console.error('Failed to retrieve user billing overview:', err);
      return res.status(500).json({ error: 'Failed to retrieve billing overview' });
    }
  }

  /**
   * POST /api/billing/checkout
   * Body: { tier: "INDIE" | "TEAM", billingCycle: "monthly" | "yearly" }
   * Returns a Polar checkout URL for the caller to redirect to.
   */
  static async createCheckout(req: Request, res: Response) {
    const tier = String(req.body?.tier ?? '').toUpperCase();
    const billingCycle = String(req.body?.billingCycle ?? 'monthly').toLowerCase();

    if (!PAID_TIERS.has(tier)) {
      return res.status(400).json({ error: 'tier must be one of INDIE, TEAM' });
    }

    if (billingCycle !== 'monthly' && billingCycle !== 'yearly') {
      return res.status(400).json({ error: 'billingCycle must be monthly or yearly' });
    }

    try {
      const userId = req.auth!.userId;
      const customer = await BillingService.getCheckoutCustomer(userId);

      const { url } = await BillingService.createCheckout({
        userId,
        username: customer?.username,
        email: customer?.email,
        tier: tier as PaidTier,
        billingCycle,
      });

      return res.json({ url });
    } catch (err) {
      if (err instanceof BillingConfigurationError) {
        console.error('Billing is not configured:', err.message);
        return res.status(503).json({ error: 'Billing is not available right now' });
      }
      console.error('Failed to create checkout session:', err);
      return res.status(500).json({ error: 'Failed to start checkout' });
    }
  }

  /**
   * POST /api/billing/webhook
   * Called by Polar. Public and unauthenticated — authenticity comes from the
   * signature check, not from a session.
   */
  static async handleWebhook(req: Request, res: Response) {
    const rawBody = req.rawBody;
    if (!rawBody) {
      console.error('🛑 Polar webhook arrived without rawBody — refusing to verify.');
      return res.status(400).json({ error: 'Missing raw body' });
    }

    let event: Awaited<ReturnType<typeof BillingService.validateWebhookEvent>>;
    try {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers[key.toLowerCase()] = value;
      }
      event = await BillingService.validateWebhookEvent(rawBody, headers);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('🛑 Rejected Polar webhook with an invalid signature:', message);
      return res.status(403).json({ error: 'Invalid signature' });
    }

    const type = event.type;

    try {
      if (CANCEL_EVENTS.has(type)) {
        const { userId } = await BillingService.syncCancellation(
          event.data as PolarSubscriptionLike, event.timestamp,
        );
        console.log(`💳 Polar ${type}: revoked access for user ${userId ?? '(unknown)'}`);
        return res.status(202).json({ received: true });
      }

      if (SYNC_EVENTS.has(type)) {
        const { userId, tier } = await BillingService.syncSubscription(
          event.data as PolarSubscriptionLike, event.timestamp,
        );
        console.log(`💳 Polar ${type}: user ${userId ?? '(unknown)'} -> ${tier}`);
        return res.status(202).json({ received: true });
      }

      // Acknowledged but not acted on. 202 stops Polar retrying deliveries we
      // deliberately ignore (orders, discounts, product updates, customers).
      return res.status(202).json({ received: true, ignored: type });
    } catch (err) {
      console.error(`💥 Failed to process Polar ${type}:`, err);
      // 500 makes Polar retry, which is what we want for a transient DB failure.
      return res.status(500).json({ error: 'Failed to process event' });
    }
  }
}
