import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller';
import { requireAuth } from '../middlewares/auth.middleware';

const router = Router();

router.get('/github', AuthController.startGitHubLogin);
router.get('/github/callback', AuthController.handleGitHubCallback);
router.get('/github-app/install', AuthController.startGitHubAppInstall);
// Configure this URL as the GitHub App's Setup URL.
router.get('/github-app/callback', AuthController.completeGitHubAppInstall);
router.get('/me', requireAuth, AuthController.getMe);
router.post('/logout', AuthController.logout);

export default router;
