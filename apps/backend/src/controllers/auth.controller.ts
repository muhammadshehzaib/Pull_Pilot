import { Request, Response } from 'express';
import axios from 'axios';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import prisma from '../config/prisma';
import { AuthService, SessionUnavailableError, sessionHash } from '../services/auth.service';
import { SocketService } from '../config/socket';
import { safeErrorMetadata } from '../utils/safe-error';
import { BillingService } from '../services/billing.service';
import {
  BACKEND_URL,
  COOKIE_MAX_AGE_MS,
  COOKIE_NAME,
  FRONTEND_URL,
  GITHUB_AUTHORIZE_URL,
  GITHUB_TOKEN_URL,
  GITHUB_USER_URL,
} from '../utils/constants';

export class AuthController {
  static async startGitHubAppInstall(req: Request, res: Response) {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) {
      res.cookie('github_app_install_after_login', '1', {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 10 * 60 * 1000,
        path: '/api/auth/github/callback',
      });
      return res.redirect(`${BACKEND_URL}/api/auth/github`);
    }
    try {
      req.auth = await AuthService.verifySession(token);
    } catch (error) {
      if (error instanceof SessionUnavailableError) return res.status(503).json({ error: error.message });
      res.clearCookie(COOKIE_NAME);
      return res.redirect(`${BACKEND_URL}/api/auth/github`);
    }

    const appSlug = process.env.GITHUB_APP_SLUG;
    if (!appSlug) return res.status(503).json({ error: 'GitHub App install is not configured' });
    await prisma.installationClaim.deleteMany({ where: { expiresAt: { lte: new Date() } } });
    const state = randomBytes(32).toString('hex');
    await prisma.installationClaim.create({
      data: {
        stateHash: createHash('sha256').update(state).digest('hex'),
        userId: req.auth!.userId,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });
    return res.redirect(`https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new?state=${state}`);
  }

  static async completeGitHubAppInstall(req: Request, res: Response) {
    const installationId = req.query.installation_id;
    const state = req.query.state;
    if (typeof installationId !== 'string' || !/^\d+$/.test(installationId) || typeof state !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid GitHub installation callback parameters' });
    }

    const stateHash = createHash('sha256').update(state).digest('hex');
    const claim = await prisma.installationClaim.findFirst({
      where: { stateHash, expiresAt: { gt: new Date() } },
    });
    if (!claim) return res.status(400).json({ error: 'Installation state is invalid, expired, or already used' });

    // The signed installation webhook identifies the GitHub account that
    // actually installed the App. Never trust installation_id from the browser
    // setup redirect on its own.
    const [user, webhookInstallation] = await Promise.all([
      prisma.user.findUnique({ where: { id: claim.userId }, select: { githubId: true } }),
      prisma.installation.findUnique({ where: { githubInstallationId: BigInt(installationId) } }),
    ]);
    if (!user || !webhookInstallation || webhookInstallation.createdByGithubId !== user.githubId) {
      return res.status(403).json({ error: 'GitHub has not confirmed that this account created the installation yet. Retry shortly.' });
    }

    // Consume the one-time state and link only after the signed webhook confirms
    // the installation actor, preventing both callback replay and ID spoofing.
    try {
      const { GitHubAppService } = await import('../services/github-app.service');
      const details = await GitHubAppService.getInstallationDetails(installationId);
      const repositories = await GitHubAppService.getInstallationRepositories(installationId);
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${claim.userId} FOR UPDATE`;
        const consumed = await tx.installationClaim.deleteMany({ where: { id: claim.id, stateHash } });
        if (consumed.count !== 1) throw new Error('Installation state has already been used');
        const installation = await tx.installation.update({
          where: { githubInstallationId: BigInt(installationId) },
          data: {
            userId: claim.userId,
            accountLogin: details.account?.login || 'unknown',
            accountType: details.account?.type || 'User',
            avatarUrl: details.account?.avatar_url || null,
          },
        });
        // A customer may subscribe before installing, or add another org later.
        // Apply their entitlement atomically with the ownership link.
        await BillingService.syncEntitlements(claim.userId, tx);
        for (const repo of repositories) {
          const githubRepoId = BigInt(repo.id);
          const existingRepo = await tx.repository.findFirst({ where: { githubRepoId } });
          const repoData = {
            userId: claim.userId,
            installationId: installation.id,
            fullName: repo.full_name,
            isPrivate: Boolean(repo.private),
            isActive: true,
            defaultBranch: repo.default_branch ?? null,
          };
          if (existingRepo && existingRepo.userId === claim.userId &&
              (!existingRepo.installationId || existingRepo.installationId === installation.id)) {
            await tx.repository.update({ where: { id: existingRepo.id }, data: repoData });
          } else if (existingRepo?.installationId === installation.id) {
            throw new Error('Repository installation is already linked to a different account');
          } else {
            await tx.repository.create({ data: { ...repoData, githubRepoId } });
          }
        }
      });
      return res.redirect(`${FRONTEND_URL}/repositories?installation=success`);
    } catch (err) {
      console.error('GitHub App installation linking failed', safeErrorMetadata(err));
      return res.status(502).json({ error: 'Could not link GitHub App installation. Please retry installation.' });
    }
  }

  static async startGitHubLogin(req: Request, res: Response) {
    const clientId = process.env.GITHUB_CLIENT_ID;

    if (!clientId) {
      return res.status(500).json({ error: 'GITHUB_CLIENT_ID not configured' });
    }

    const redirectUri = `${BACKEND_URL}/api/auth/github/callback`;
    const scope = 'read:user user:email';
    const state = randomBytes(32).toString('hex');
    res.cookie('github_oauth_state', state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 10 * 60 * 1000,
      path: '/api/auth/github/callback',
    });
    const url = `${GITHUB_AUTHORIZE_URL}?client_id=${clientId}&redirect_uri=${encodeURIComponent(
      redirectUri,
    )}&scope=${encodeURIComponent(scope)}&state=${state}`;

    return res.redirect(url);
  }

  static async handleGitHubCallback(req: Request, res: Response) {
    const code = req.query.code as string | undefined;
    if (!code) return res.status(400).json({ error: 'Missing OAuth code' });
    const state = req.query.state;
    const expectedState = req.cookies?.github_oauth_state;
    const installAfterLogin = req.cookies?.github_app_install_after_login === '1';
    res.clearCookie('github_oauth_state', { path: '/api/auth/github/callback' });
    res.clearCookie('github_app_install_after_login', { path: '/api/auth/github/callback' });
    if (typeof state !== 'string' || typeof expectedState !== 'string' || !/^[0-9a-f]{64}$/.test(state) ||
        state.length !== expectedState.length || Buffer.byteLength(state) !== Buffer.byteLength(expectedState) ||
        !timingSafeEqual(Buffer.from(state), Buffer.from(expectedState))) {
      return res.status(400).json({ error: 'Invalid or expired OAuth state' });
    }
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return res.status(500).json({ error: 'GitHub OAuth not configured' });
    }

    let stage: 'token_exchange' | 'profile_fetch' | 'user_save' | 'session_issue' = 'token_exchange';
    try {
      // 1. Exchange code for access token
      const tokenRes = await axios.post(
        GITHUB_TOKEN_URL,
        { client_id: clientId, client_secret: clientSecret, code },
        { headers: { Accept: 'application/json' } },
      );
      const accessToken: string | undefined = tokenRes.data?.access_token;
      if (!accessToken) {
        return res.status(401).json({ error: 'GitHub did not return an access token' });
      }

      // 2. Fetch GitHub profile
      stage = 'profile_fetch';
      const profileRes = await axios.get(GITHUB_USER_URL, {
        headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'ai-pr-reviewer' },
      });
      const profile = profileRes.data;

      // 3. Upsert user
      stage = 'user_save';
      const user = await prisma.user.upsert({
        where: { githubId: String(profile.id) },
        create: {
          githubId: String(profile.id),
          username: profile.login,
          email: profile.email,
          avatarUrl: profile.avatar_url,
        },
        update: {
          username: profile.login,
          email: profile.email,
          avatarUrl: profile.avatar_url,
        },
      });

      // 4. Issue JWT and set cookie
      stage = 'session_issue';
      const token = AuthService.issueToken({ userId: user.id, githubId: user.githubId });
      res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: COOKIE_MAX_AGE_MS,
      });

      return res.redirect(installAfterLogin
        ? `${BACKEND_URL}/api/auth/github-app/install`
        : `${FRONTEND_URL}/dashboard`);
    } catch (err) {
      console.error('GitHub OAuth callback failed', { stage, ...safeErrorMetadata(err) });
      return res.status(500).json({ error: 'OAuth exchange failed' });
    }
  }

  static async getMe(req: Request, res: Response) {
    const user = await prisma.user.findUnique({
      where: { id: req.auth!.userId },
      select: { id: true, githubId: true, username: true, email: true, avatarUrl: true },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({ user });
  }

  static async logout(req: Request, res: Response) {
    const token = req.cookies?.[COOKIE_NAME] || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined);
    try {
      if (token) {
        await AuthService.revokeToken(token);
        SocketService.disconnectSession(sessionHash(token));
      }
    } catch {
      return res.status(503).json({ error: 'Sign out could not be completed. Please retry.' });
    }
    res.clearCookie(COOKIE_NAME, { path: '/', httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    return res.json({ status: 'OK' });
  }
}
