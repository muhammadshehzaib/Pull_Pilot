import { Router } from 'express';
import { RepositoryController } from '../controllers/repository.controller';
import { requireAuth } from '../middlewares/auth.middleware';
import { FeedbackLoopController } from '../controllers/feedback-loop.controller';
import { feedbackRateLimit } from '../middlewares/feedback-rate-limit';

const router = Router();

router.use(requireAuth);
router.get('/', RepositoryController.list);
router.post('/', RepositoryController.register);
router.delete('/:id', RepositoryController.deactivate);
router.post('/:id/analyze', RepositoryController.triggerAnalysis);

// Phase 8 Historical Intelligence — Settings & Insights
router.get('/:id/historical-intelligence/settings', RepositoryController.getHistoricalSettings);
router.patch('/:id/historical-intelligence/settings', RepositoryController.updateHistoricalSettings);
router.get('/:id/historical-insights', RepositoryController.getHistoricalInsights);
router.get('/:id/feedback-insights', feedbackRateLimit, FeedbackLoopController.insights);
router.put('/:id/feedback-adaptation', feedbackRateLimit, FeedbackLoopController.settings);

export default router;
