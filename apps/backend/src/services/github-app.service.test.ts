import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import { inspect } from 'node:util';
import { GitHubAppService } from './github-app.service';

vi.mock('axios');

describe('GitHubAppService', () => {
  // Generate a real ephemeral RSA key pair for testing JWT signing
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    GitHubAppService.clearCache();
    process.env = {
      ...originalEnv,
      GITHUB_APP_ID: '123456',
      GITHUB_APP_PRIVATE_KEY: privateKey,
      GITHUB_ACCESS_TOKEN: 'ghp_test_token_legacy',
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = originalEnv;
  });

  it('generates a valid RS256 JWT using GitHub App ID and Private Key', () => {
    const token = GitHubAppService.generateAppJwt();
    expect(token).toBeDefined();

    const decoded: any = jwt.decode(token);
    expect(decoded.iss).toBe('123456');
    expect(decoded.exp - decoded.iat).toBe(660); // 10m + 60s skew
  });

  it('throws an error if GITHUB_APP_ID is missing', () => {
    delete process.env.GITHUB_APP_ID;
    expect(() => GitHubAppService.generateAppJwt()).toThrowError(
      'GitHub App is not configured'
    );
  });

  it('exchanges App JWT for installation access token and caches it', async () => {
    (axios.post as any).mockResolvedValueOnce({
      data: {
        token: 'ghs_installation_token_abc',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });

    const token1 = await GitHubAppService.getInstallationToken(98765);
    expect(token1).toBe('ghs_installation_token_abc');
    expect(axios.post).toHaveBeenCalledTimes(1);

    // Second call should return cached token without calling axios again
    const token2 = await GitHubAppService.getInstallationToken(98765);
    expect(token2).toBe('ghs_installation_token_abc');
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it('falls back to GITHUB_ACCESS_TOKEN if App credentials are not provided', async () => {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;

    const octokit = await GitHubAppService.getInstallationOctokit();
    expect(octokit).toBeDefined();
  });

  it('does not log upstream bodies, messages, or tokens when installation token exchange fails', async () => {
    const credential = 'fake-app-jwt-must-stay-private';
    const error = Object.assign(new Error(credential), {
      code: 'ERR_BAD_RESPONSE',
      config: { headers: { Authorization: `Bearer ${credential}` } },
      response: { status: 503, data: { message: credential, token: credential } },
    });
    vi.mocked(axios.post).mockRejectedValueOnce(error);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(GitHubAppService.getInstallationToken(98765)).rejects.toThrow('GitHub App installation token exchange failed for ID 98765');
    expect(inspect(errorLog.mock.calls, { depth: null })).not.toContain(credential);
    expect(errorLog).toHaveBeenCalledWith('GitHub App installation token exchange failed', { status: 503, code: 'ERR_BAD_RESPONSE' });
  });
});
