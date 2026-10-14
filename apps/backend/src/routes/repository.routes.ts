import { Router } from 'express';
import { RepositoryController } from '../controllers/repository.controller';
import { requireAuth } from '../middlewares/auth.middleware';
import { FeedbackLoopController } from '../controllers/feedback-loop.controller';
import { feedbackRateLimit } from '../middlewares/feedback-rate-limit';
import { requireRepositoryAccess } from '../middlewares/repository-access.middleware';

const router = Router();

router.use(requireAuth);
router.get('/', RepositoryController.list);
router.post('/', RepositoryController.register);
router.delete('/:id', RepositoryController.deactivate);
// Disconnection stays available even after GitHub permission is revoked.
const access = requireRepositoryAccess('repository', 'id');
router.post('/:id/analyze', access, RepositoryController.triggerAnalysis);

// Phase 8 Historical Intelligence — Settings & Insights
router.get('/:id/historical-intelligence/settings', access, RepositoryController.getHistoricalSettings);
router.patch('/:id/historical-intelligence/settings', access, RepositoryController.updateHistoricalSettings);
router.get('/:id/historical-insights', access, RepositoryController.getHistoricalInsights);
router.get('/:id/feedback-insights', feedbackRateLimit, access, FeedbackLoopController.insights);
router.put('/:id/feedback-adaptation', feedbackRateLimit, access, FeedbackLoopController.settings);

export default router;
