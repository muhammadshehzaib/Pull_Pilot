import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { inspect } from 'node:util';

const { mockAxiosPost, mockAxiosGet, mockUserUpsert, mockUserFind, mockUserCreate } =
  vi.hoisted(() => ({
    mockAxiosPost: vi.fn(),
    mockAxiosGet: vi.fn(),
    mockUserUpsert: vi.fn(),
    mockUserFind: vi.fn(),
    mockUserCreate: vi.fn(),
  }));

vi.mock('axios', () => ({
  default: {
    revokedSession: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({})) }, post: mockAxiosPost, get: mockAxiosGet },
}));

vi.mock('../config/prisma', () => ({
  default: {
    installationClaim: { findFirst: vi.fn() },
    installation: { findUnique: vi.fn() },
    user: {
      upsert: mockUserUpsert,
      findUnique: mockUserFind,
      create: mockUserCreate,
    },
  },
}));

import { AuthController } from './auth.controller';
import { AuthService } from '../services/auth.service';
import { GitHubAppService } from '../services/github-app.service';
import prisma from '../config/prisma';
import { mockReq, mockRes } from '../test-utils/express-mocks';

const OAUTH_STATE = 'a'.repeat(64);
const oauthCallbackReq = (query: Record<string, string>) =>
  mockReq({ query: { ...query, state: OAUTH_STATE }, cookies: { github_oauth_state: OAUTH_STATE } });

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GITHUB_CLIENT_ID = 'test-client-id';
  process.env.GITHUB_CLIENT_SECRET = 'test-client-secret';
  process.env.BACKEND_URL = 'http://backend.test';
  process.env.FRONTEND_URL = 'http://frontend.test';
  delete process.env.NODE_ENV;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

describe('AuthController.startGitHubLogin', () => {
  it('redirects to the GitHub authorize URL with the configured client_id', async () => {
    const req = mockReq();
    const res = mockRes();
    await AuthController.startGitHubLogin(req, res);

    expect(res.redirect).toHaveBeenCalledOnce();
    const url = res.redirect.mock.calls[0][0] as string;
    expect(url).toContain('https://github.com/login/oauth/authorize');
    expect(url).toContain('client_id=test-client-id');
    expect(url).toContain('scope=read%3Auser%20user%3Aemail');
  });

  it('returns 500 when GITHUB_CLIENT_ID is missing', async () => {
    delete process.env.GITHUB_CLIENT_ID;
    const req = mockReq();
    const res = mockRes();

    await AuthController.startGitHubLogin(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'GITHUB_CLIENT_ID not configured' });
  });

  it('never bypasses OAuth via ?dev=true', async () => {
    const req = mockReq({ query: { dev: 'true' } });
    const res = mockRes();

    await AuthController.startGitHubLogin(req, res);

    expect(mockUserFind).not.toHaveBeenCalled();
    expect(mockUserCreate).not.toHaveBeenCalled();
    expect(res.cookie).toHaveBeenCalledWith(
      'github_oauth_state',
      expect.stringMatching(/^[0-9a-f]{64}$/),
      expect.objectContaining({ httpOnly: true, sameSite: 'lax' }),
    );
    expect(res.redirect.mock.calls[0][0]).toContain('github.com/login/oauth/authorize');
  });
});

describe('AuthController.handleGitHubCallback', () => {
  it.each(['token_exchange', 'profile_fetch', 'user_save', 'session_issue'])(
    'keeps credentials out of logs and failure responses during %s', async stage => {
      const clientSecret = 'fake-client-secret-must-stay-private';
      const accessToken = 'fake-github-token-must-stay-private';
      const oauthCode = 'fake-oauth-code-must-stay-private';
      process.env.GITHUB_CLIENT_SECRET = clientSecret;
      const sensitiveError = Object.assign(new Error(`Upstream echoed ${clientSecret} ${accessToken} ${oauthCode}`), {
        code: 'ERR_BAD_RESPONSE',
        config: {
          url: `https://github.com/?code=${oauthCode}&state=${OAUTH_STATE}`,
          data: JSON.stringify({ client_secret: clientSecret, code: oauthCode }),
          headers: { Authorization: `Bearer ${accessToken}`, Cookie: 'private-session-cookie' },
        },
        response: { status: 502, data: { access_token: accessToken, client_secret: clientSecret } },
        cause: new Error(`nested ${accessToken}`),
      });
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const infoLog = vi.spyOn(console, 'log').mockImplementation(() => {});
      if (stage === 'token_exchange') {
        mockAxiosPost.mockRejectedValueOnce(sensitiveError);
      } else {
        mockAxiosPost.mockResolvedValueOnce({ data: { access_token: accessToken } });
        if (stage === 'profile_fetch') {
          mockAxiosGet.mockRejectedValueOnce(sensitiveError);
        } else {
          mockAxiosGet.mockResolvedValueOnce({ data: { id: 99, login: 'octocat' } });
          if (stage === 'user_save') {
            mockUserUpsert.mockRejectedValueOnce(sensitiveError);
          } else {
            mockUserUpsert.mockResolvedValueOnce({ id: 'u-1', githubId: '99' });
            vi.spyOn(AuthService, 'issueToken').mockImplementationOnce(() => { throw sensitiveError; });
          }
        }
      }
      const res = mockRes();
      await AuthController.handleGitHubCallback(oauthCallbackReq({ code: oauthCode }), res);

      const output = inspect([errorLog.mock.calls, warnLog.mock.calls, infoLog.mock.calls, res.json.mock.calls], { depth: null });
      for (const value of [clientSecret, accessToken, oauthCode, OAUTH_STATE, 'private-session-cookie', 'Upstream echoed', 'nested']) {
        expect(output).not.toContain(value);
      }
      expect(errorLog).toHaveBeenCalledWith('GitHub OAuth callback failed', {
        stage, status: 502, code: 'ERR_BAD_RESPONSE',
      });
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'OAuth exchange failed' });
      expect(res.cookie).not.toHaveBeenCalled();
      expect(res.redirect).not.toHaveBeenCalled();
    },
  );

  it.each([new Error('private-error-message'), 'private-thrown-string', null])('does not log arbitrary thrown values: %#', async error => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockAxiosPost.mockRejectedValueOnce(error);
    const res = mockRes();
    await AuthController.handleGitHubCallback(oauthCallbackReq({ code: 'x' }), res);
    expect(errorLog).toHaveBeenCalledWith('GitHub OAuth callback failed', { stage: 'token_exchange' });
    expect(res.json).toHaveBeenCalledWith({ error: 'OAuth exchange failed' });
  });

  it('completes the flow: exchange code -> fetch profile -> upsert -> set cookie -> redirect', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { access_token: 'gh-access-xyz' } });
    mockAxiosGet.mockResolvedValueOnce({
      data: { id: 99, login: 'octocat', email: 'oct@cat.io', avatar_url: 'http://a.png' },
    });
    mockUserUpsert.mockResolvedValueOnce({ id: 'u-1', githubId: '99' });

    const req = oauthCallbackReq({ code: 'oauth-code-abc' });
    const res = mockRes();

    await AuthController.handleGitHubCallback(req, res);

    expect(mockAxiosPost).toHaveBeenCalledWith(
      'https://github.com/login/oauth/access_token',
      expect.objectContaining({ code: 'oauth-code-abc' }),
      expect.any(Object),
    );
    expect(mockUserUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { githubId: '99' } }),
    );
    expect(res.cookie).toHaveBeenCalledWith(
      'auth_token',
      expect.any(String),
      expect.objectContaining({ httpOnly: true, sameSite: 'lax' }),
    );
    expect(res.redirect).toHaveBeenCalledWith('http://frontend.test/dashboard');
  });

  it('returns 400 when code is missing', async () => {
    const req = mockReq({ query: {} });
    const res = mockRes();

    await AuthController.handleGitHubCallback(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Missing OAuth code' });
  });

  it.each([undefined, 'b'.repeat(64), 'invalid-state'])('rejects invalid OAuth state before exchanging credentials: %#', async state => {
    const res = mockRes();
    await AuthController.handleGitHubCallback(mockReq({
      query: { code: 'private-code', state }, cookies: { github_oauth_state: OAUTH_STATE },
    }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired OAuth state' });
    expect(mockAxiosPost).not.toHaveBeenCalled();
    expect(res.cookie).not.toHaveBeenCalled();
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('returns 500 when GitHub OAuth credentials are not configured', async () => {
    delete process.env.GITHUB_CLIENT_SECRET;
    const req = oauthCallbackReq({ code: 'x' });
    const res = mockRes();

    await AuthController.handleGitHubCallback(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'GitHub OAuth not configured' });
  });

  it('returns 401 when GitHub did not return an access token', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { error: 'bad_verification_code' } });
    const req = oauthCallbackReq({ code: 'x' });
    const res = mockRes();

    await AuthController.handleGitHubCallback(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'GitHub did not return an access token',
    });
  });

  it('returns 500 when the profile request blows up', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { access_token: 'tok' } });
    mockAxiosGet.mockRejectedValueOnce(new Error('GitHub down'));

    const req = oauthCallbackReq({ code: 'x' });
    const res = mockRes();

    await AuthController.handleGitHubCallback(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'OAuth exchange failed' });
    // Generic message — must NOT leak "GitHub down" to client
    expect(res.json.mock.calls[0][0]).not.toMatchObject({ error: expect.stringContaining('GitHub down') });
  });

  it('does NOT set cookie or redirect on failure', async () => {
    mockAxiosPost.mockRejectedValueOnce(new Error('boom'));
    const req = oauthCallbackReq({ code: 'x' });
    const res = mockRes();

    await AuthController.handleGitHubCallback(req, res);

    expect(res.cookie).not.toHaveBeenCalled();
    expect(res.redirect).not.toHaveBeenCalled();
  });
});

describe('AuthController.completeGitHubAppInstall — safe failure logging', () => {
  it('does not log GitHub App request credentials while linking an installation', async () => {
    vi.mocked(prisma.installationClaim.findFirst).mockResolvedValueOnce({ id: 'claim', userId: 'u-1' } as any);
    mockUserFind.mockResolvedValueOnce({ githubId: '99' });
    vi.mocked(prisma.installation.findUnique).mockResolvedValueOnce({ createdByGithubId: '99' } as any);
    const credential = 'fake-installation-bearer-token';
    const error = Object.assign(new Error(credential), {
      code: 'ERR_BAD_REQUEST',
      request: { headers: { authorization: `Bearer ${credential}` } },
      response: { status: 403, data: { message: credential } },
    });
    vi.spyOn(GitHubAppService, 'getInstallationDetails').mockRejectedValueOnce(error);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = mockRes();
    await AuthController.completeGitHubAppInstall(mockReq({ query: { installation_id: '123', state: 'state' } }), res);
    expect(inspect([errorLog.mock.calls, res.json.mock.calls], { depth: null })).not.toContain(credential);
    expect(errorLog).toHaveBeenCalledWith('GitHub App installation linking failed', { status: 403, code: 'ERR_BAD_REQUEST' });
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.redirect).not.toHaveBeenCalled();
  });
});

describe('AuthController.getMe', () => {
  it('returns the authenticated user', async () => {
    mockUserFind.mockResolvedValueOnce({
      id: 'u-1',
      githubId: '99',
      username: 'octocat',
      email: 'o@c.io',
      avatarUrl: null,
    });

    const req = mockReq();
    (req as any).auth = { userId: 'u-1', githubId: '99' };
    const res = mockRes();

    await AuthController.getMe(req, res);

    expect(mockUserFind).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'u-1' } }),
    );
    expect(res.json).toHaveBeenCalledWith({
      user: expect.objectContaining({ id: 'u-1' }),
    });
  });

  it('returns 404 when the user no longer exists', async () => {
    mockUserFind.mockResolvedValueOnce(null);

    const req = mockReq();
    (req as any).auth = { userId: 'u-gone', githubId: '99' };
    const res = mockRes();

    await AuthController.getMe(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'User not found' });
  });
});

describe('AuthController.logout', () => {
  it('does not report success or clear the cookie when revocation fails', async () => {
    vi.spyOn(AuthService, 'revokeToken').mockRejectedValueOnce(new Error('database failed with private data'));
    const res = mockRes();
    await AuthController.logout(mockReq({ cookies: { auth_token: 'session' } }), res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.clearCookie).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ error: 'Sign out could not be completed. Please retry.' });
  });
  it('clears the auth_token cookie and returns OK', async () => {
    const req = mockReq();
    const res = mockRes();

    await AuthController.logout(req, res);

    expect(res.clearCookie).toHaveBeenCalledWith('auth_token', expect.objectContaining({ path: '/' }));
    expect(res.json).toHaveBeenCalledWith({ status: 'OK' });
  });
});
