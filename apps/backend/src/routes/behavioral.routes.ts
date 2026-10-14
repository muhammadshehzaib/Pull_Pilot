import { Router } from 'express';
import { requireAuth } from '../middlewares/auth.middleware';
import { BehavioralController } from '../controllers/behavioral.controller';
import { requireRepositoryAccess } from '../middlewares/repository-access.middleware';

const router = Router();
// CI has GitHub OIDC + a one-use dispatch binding, never a browser session.
router.post('/ci/:runId/claim', BehavioralController.claim);
router.post('/ci/:runId/finish', BehavioralController.finish);
router.use(requireAuth);
router.use('/jobs/:jobId', requireRepositoryAccess('job', 'jobId'));
router.get('/jobs/:jobId', BehavioralController.get);
router.put('/jobs/:jobId/config', BehavioralController.configure);
router.post('/jobs/:jobId/runs', BehavioralController.start);
export default router;
