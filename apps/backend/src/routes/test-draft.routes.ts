import { Router } from 'express';
import { TestDraftController } from '../controllers/test-draft.controller';
import { requireAuth } from '../middlewares/auth.middleware';
import { requireRepositoryAccess } from '../middlewares/repository-access.middleware';

/**
 * Test-draft endpoints. Drafts are created from a review's test-gap scenario,
 * edited while pending, and finally turned into a PR. Every handler scopes its
 * query to the authenticated user's repository, so one tenant can never read or
 * write another's draft.
 */
const router = Router();

router.use(requireAuth);
router.post('/', requireRepositoryAccess('job', 'jobId', true), TestDraftController.create);
router.use('/:id', requireRepositoryAccess('draft', 'id'));
router.get('/:id', TestDraftController.get);
router.put('/:id', TestDraftController.update);
router.delete('/:id', TestDraftController.discard);
router.post('/:id/create-pr', TestDraftController.createPr);

export default router;
