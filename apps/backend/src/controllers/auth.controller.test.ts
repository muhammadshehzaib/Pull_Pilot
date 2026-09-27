import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockAxiosPost, mockAxiosGet, mockUserUpsert, mockUserFind, mockUserCreate } =
  vi.hoisted(() => ({
    mockAxiosPost: vi.fn(),
    mockAxiosGet: vi.fn(),
    mockUserUpsert: vi.fn(),
    mockUserFind: vi.fn(),
    mockUserCreate: vi.fn(),
  }));

vi.mock('axios', () => ({
  default: { post: mockAxiosPost, get: mockAxiosGet },
}));

vi.mock('../config/prisma', () => ({
  default: {
    user: {
      upsert: mockUserUpsert,
      findUnique: mockUserFind,
      create: mockUserCreate,
    },
  },
}));

import { AuthController } from './auth.controller';
import { mockReq, mockRes } from '../test-utils/express-mocks';

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
    expect(res.cookie).not.toHaveBeenCalled();
    expect(res.redirect.mock.calls[0][0]).toContain('github.com/login/oauth/authorize');
  });
});

describe('AuthController.handleGitHubCallback', () => {
  it('completes the flow: exchange code -> fetch profile -> upsert -> set cookie -> redirect', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { access_token: 'gh-access-xyz' } });
    mockAxiosGet.mockResolvedValueOnce({
      data: { id: 99, login: 'octocat', email: 'oct@cat.io', avatar_url: 'http://a.png' },
    });
    mockUserUpsert.mockResolvedValueOnce({ id: 'u-1', githubId: '99' });

    const req = mockReq({ query: { code: 'oauth-code-abc' } });
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

  it('returns 500 when GitHub OAuth credentials are not configured', async () => {
    delete process.env.GITHUB_CLIENT_SECRET;
    const req = mockReq({ query: { code: 'x' } });
    const res = mockRes();

    await AuthController.handleGitHubCallback(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'GitHub OAuth not configured' });
  });

  it('returns 401 when GitHub did not return an access token', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { error: 'bad_verification_code' } });
    const req = mockReq({ query: { code: 'x' } });
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

    const req = mockReq({ query: { code: 'x' } });
    const res = mockRes();

    await AuthController.handleGitHubCallback(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'OAuth exchange failed' });
    // Generic message — must NOT leak "GitHub down" to client
    expect(res.json.mock.calls[0][0]).not.toMatchObject({ error: expect.stringContaining('GitHub down') });
  });

  it('does NOT set cookie or redirect on failure', async () => {
    mockAxiosPost.mockRejectedValueOnce(new Error('boom'));
    const req = mockReq({ query: { code: 'x' } });
    const res = mockRes();

    await AuthController.handleGitHubCallback(req, res);

    expect(res.cookie).not.toHaveBeenCalled();
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
  it('clears the auth_token cookie and returns OK', async () => {
    const req = mockReq();
    const res = mockRes();

    await AuthController.logout(req, res);

    expect(res.clearCookie).toHaveBeenCalledWith('auth_token');
    expect(res.json).toHaveBeenCalledWith({ status: 'OK' });
  });
});
