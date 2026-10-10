import { Router } from 'express';
import { requireAuth } from '../middlewares/auth.middleware';
import { feedbackRateLimit } from '../middlewares/feedback-rate-limit';
import { engineeringHealth } from '../services/analytics/dashboard.service';
import { DashboardError, parseScope } from '../services/analytics/model';

const router = Router();
router.use(requireAuth, feedbackRateLimit);
for (const endpoint of ['engineering-health', 'risk-trend', 'repositories', 'reviews'] as const) {
  router.get(`/${endpoint}`, async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const result = await engineeringHealth(req.auth!.userId, parseScope(req.query));
      const part = endpoint === 'risk-trend' ? { trend: result.trend } : endpoint === 'repositories' ? { repositories: result.repositories } :
        endpoint === 'reviews' ? { reviews: result.reviews } : result;
      res.json({ ...part, scope: result.scope, coverage: result.coverage });
    } catch (error) {
      if (error instanceof DashboardError) res.status(error.status).json({ error: error.message });
      else res.status(503).json({ error: 'Engineering health is temporarily unavailable. Please retry.' });
    }
  });
}
export default router;
