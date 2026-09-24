import { Request, Response } from 'express';
import axios from 'axios';
import prisma from '../config/prisma';
import { AuthService } from '../services/auth.service';

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';

const COOKIE_NAME = 'auth_token';
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4000';

export class AuthController {
  static async startGitHubLogin(req: Request, res: Response) {
    const clientId = process.env.GITHUB_CLIENT_ID;
    const isDevAuth = process.env.NODE_ENV === 'development' && (process.env.DEV_AUTH === 'true' || req.query.dev === 'true' || !clientId);

    if (isDevAuth) {
      let user = await prisma.user.findFirst();
      if (!user) {
        user = await prisma.user.create({
          data: {
            githubId: 'dev-local-user',
            username: 'muhammadshehzaib',
            email: 'dev@local.test',
            avatarUrl: 'https://github.com/muhammadshehzaib.png',
          },
        });
      }
      const token = AuthService.issueToken({
        userId: user.id,
        githubId: user.githubId,
      });

      res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        maxAge: COOKIE_MAX_AGE_MS,
      });

      return res.redirect(`${FRONTEND_URL}/dashboard`);
    }

    if (!clientId) {
      return res.status(500).json({ error: 'GITHUB_CLIENT_ID not configured' });
    }

    const redirectUri = `${BACKEND_URL}/api/auth/github/callback`;
    const scope = 'read:user user:email';
    const url = `${GITHUB_AUTHORIZE_URL}?client_id=${clientId}&redirect_uri=${encodeURIComponent(
      redirectUri,
    )}&scope=${encodeURIComponent(scope)}`;

    return res.redirect(url);
  }

  static async handleGitHubCallback(req: Request, res: Response) {
    const code = req.query.code as string | undefined;
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;

    if (!code) return res.status(400).json({ error: 'Missing OAuth code' });
    if (!clientId || !clientSecret) {
      return res.status(500).json({ error: 'GitHub OAuth not configured' });
    }

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
      const profileRes = await axios.get(GITHUB_USER_URL, {
        headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'ai-pr-reviewer' },
      });
      const profile = profileRes.data;

      // 3. Upsert user
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
      const token = AuthService.issueToken({ userId: user.id, githubId: user.githubId });
      res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: COOKIE_MAX_AGE_MS,
      });

      return res.redirect(`${FRONTEND_URL}/dashboard`);
    } catch (err) {
      console.error('🔴 GitHub OAuth callback failure:', err);
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

  static async logout(_req: Request, res: Response) {
    res.clearCookie(COOKIE_NAME);
    return res.json({ status: 'OK' });
  }
}
