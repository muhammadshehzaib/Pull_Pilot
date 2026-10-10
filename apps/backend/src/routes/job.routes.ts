import { Router } from 'express';
import { JobController } from '../controllers/job.controller';
import { TestDraftController } from '../controllers/test-draft.controller';
import { requireAuth } from '../middlewares/auth.middleware';

const router = Router();

router.use(requireAuth);
router.get('/', JobController.list);
router.get('/:id', JobController.get);
// Drafts belonging to one review (list only; create/edit/PR live under
// /api/test-drafts). Path does not overlap `/:id`.
router.get('/:id/test-drafts', TestDraftController.listForJob);
router.post('/:id/cancel', JobController.cancel);

export default router;
