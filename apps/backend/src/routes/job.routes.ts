import { Router } from 'express';
import { JobController } from '../controllers/job.controller';
import { TestDraftController } from '../controllers/test-draft.controller';
import { FindingController } from '../controllers/finding.controller';
import { requireAuth } from '../middlewares/auth.middleware';
import { FeedbackLoopController } from '../controllers/feedback-loop.controller';
import { feedbackRateLimit } from '../middlewares/feedback-rate-limit';

const router = Router();

router.use(requireAuth);
router.get('/', JobController.list);
router.get('/:id', JobController.get);
// Drafts belonging to one review (list only; create/edit/PR live under
// /api/test-drafts). Path does not overlap `/:id`.
router.get('/:id/test-drafts', TestDraftController.listForJob);
router.post('/:id/cancel', JobController.cancel);

// Phase 8 Historical Intelligence — Finding occurrences and developer feedback
router.get('/:id/findings', FindingController.listForJob);
router.put('/:id/findings/:findingId/feedback', feedbackRateLimit, FindingController.updateFeedback);
router.put('/:id/findings/:findingId/workflow', feedbackRateLimit, FeedbackLoopController.workflow);
router.get('/:id/findings/:findingId/workflow/events', feedbackRateLimit, FeedbackLoopController.events);
router.post('/:id/findings/:findingId/rule-draft', feedbackRateLimit, FeedbackLoopController.draft);
router.post('/:id/findings/:findingId/rule', feedbackRateLimit, FeedbackLoopController.createRule);
router.get('/:id/findings/:findingId/feedback/events', FindingController.getFeedbackEvents);
router.post('/:id/findings/backfill', FindingController.backfillLegacyFindings);

export default router;
