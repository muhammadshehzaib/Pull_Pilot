import { Router } from 'express';
import { JobController } from '../controllers/job.controller';
import { requireAuth } from '../middlewares/auth.middleware';

const router = Router();

router.use(requireAuth);
router.get('/', JobController.list);
router.get('/:id', JobController.get);
router.post('/:id/cancel', JobController.cancel);

export default router;
