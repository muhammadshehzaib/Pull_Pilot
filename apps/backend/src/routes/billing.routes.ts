import { Router } from 'express';
import { BillingController } from '../controllers/billing.controller';
import { requireAuth } from '../middlewares/auth.middleware';

const router = Router();

// Public: view plan tiers and feature comparisons
router.get('/plans', BillingController.getPlans);

// Called by Polar. Deliberately unauthenticated — authenticity comes from the
// signature check in the handler, which needs the raw request body.
router.post('/webhook', BillingController.handleWebhook);

// Protected: view authenticated user's active plan and monthly review usage
router.get('/usage', requireAuth, BillingController.getUsage);

// Protected: start a Polar checkout for a paid tier
router.post('/checkout', requireAuth, BillingController.createCheckout);

export default router;