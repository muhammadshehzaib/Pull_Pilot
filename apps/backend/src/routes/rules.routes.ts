import { Router } from 'express';
import { RulesController } from '../controllers/rules.controller';
import { requireAuth } from '../middlewares/auth.middleware';

/**
 * Rule endpoints are nested under /api/repositories so a rule's URL names its
 * repository. Mounted alongside repository.routes.ts on the same base path —
 * the path patterns do not overlap.
 */
const router = Router();

router.use(requireAuth);
router.get('/:repoId/rules', RulesController.list);
router.post('/:repoId/rules', RulesController.create);
router.put('/:repoId/rules/:ruleId', RulesController.update);
router.delete('/:repoId/rules/:ruleId', RulesController.remove);

export default router;
