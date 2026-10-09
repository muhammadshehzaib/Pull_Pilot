import jwt from 'jsonwebtoken';
import axios from 'axios';
import { Octokit } from '@octokit/rest';
import fs from 'fs';
import path from 'path';
import { GitHubService } from './github.service';

interface CachedToken {
  token: string;
  expiresAt: number; // Unix timestamp in ms
}

export class GitHubAppService {
  private static tokenCache: Map<string, CachedToken> = new Map();

  /**
   * Resolves the GitHub App Private Key from env (raw PEM string, Base64 string, or filepath).
   */
  public static getPrivateKey(): string | null {
    if (process.env.GITHUB_APP_PRIVATE_KEY) {
      let key = process.env.GITHUB_APP_PRIVATE_KEY.trim();
      // If base64 encoded PEM, decode it
      if (!key.includes('BEGIN RSA PRIVATE KEY') && !key.includes('BEGIN PRIVATE KEY')) {
        try {
          const decoded = Buffer.from(key, 'base64').toString('utf-8');
          if (decoded.includes('PRIVATE KEY')) {
            return decoded;
          }
        } catch {
          // ignore error and proceed
        }
      }
      // Handle escaped newlines from .env
      return key.replace(/\\n/g, '\n');
    }

    if (process.env.GITHUB_APP_PRIVATE_KEY_PATH) {
      try {
        const rawPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH.trim();
        const candidatePaths = [
          rawPath,
          path.resolve(process.cwd(), rawPath),
          path.resolve(process.cwd(), 'apps/backend', rawPath),
          path.resolve(__dirname, '..', '..', rawPath),
        ];

        for (const p of candidatePaths) {
          if (fs.existsSync(p)) {
            return fs.readFileSync(p, 'utf-8');
          }
        }
        console.error(`Private key file not found at any resolved location for: ${rawPath}`);
      } catch (err) {
        console.error('Failed to read private key from path:', err);
      }
    }

    return null;
  }

  /**
   * Generates a signed RS256 JSON Web Token (JWT) authenticating the GitHub App.
   * Valid for max 10 minutes according to GitHub API specifications.
   */
  public static generateAppJwt(): string {
    const appId = process.env.GITHUB_APP_ID;
    const privateKey = this.getPrivateKey();

    if (!appId || !privateKey) {
      throw new Error('GitHub App is not configured (missing GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY)');
    }

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iat: now - 60, // Issued 60 seconds in the past to account for clock drift
      exp: now + (10 * 60), // 10 minutes maximum
      iss: appId,
    };

    return jwt.sign(payload, privateKey, { algorithm: 'RS256' });
  }

  /** Retrieves trusted installation metadata for the App setup callback. */
  public static async getInstallationDetails(installationId: string): Promise<any> {
    const response = await axios.get(`https://api.github.com/app/installations/${installationId}`, {
      headers: {
        Authorization: `Bearer ${this.generateAppJwt()}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'AI-PR-Reviewer-App',
      },
    });
    return response.data;
  }

  /** Lists the repositories currently authorized for an installation. */
  public static async getInstallationRepositories(installationId: string): Promise<any[]> {
    const octokit = await this.getInstallationOctokit(installationId);
    const result = await octokit.paginate(octokit.apps.listReposAccessibleToInstallation, { per_page: 100 });
    return result as any[];
  }

  /**
   * Obtains a short-lived Installation Access Token for a specific installation ID.
   * Uses an in-memory cache with 5-minute pre-expiration renewal.
   */
  public static async getInstallationToken(installationId: string | number): Promise<string> {
    const cacheKey = String(installationId);
    const cached = this.tokenCache.get(cacheKey);
    const nowMs = Date.now();

    // Cache hit: must have at least 5 minutes of validity left
    if (cached && cached.expiresAt - nowMs > 5 * 60 * 1000) {
      return cached.token;
    }

    const appJwt = this.generateAppJwt();

    try {
      const response = await axios.post(
        `https://api.github.com/app/installations/${installationId}/access_tokens`,
        {},
        {
          headers: {
            Authorization: `Bearer ${appJwt}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'AI-PR-Reviewer-App',
          },
        }
      );

      const token = response.data.token as string;
      const expiresAt = new Date(response.data.expires_at).getTime();

      this.tokenCache.set(cacheKey, { token, expiresAt });
      return token;
    } catch (err: any) {
      console.error(`Failed to generate installation token for installation ${installationId}:`, err?.response?.data || err.message);
      throw new Error(`GitHub App installation token exchange failed for ID ${installationId}`);
    }
  }

  /**
   * Instantiates an Octokit client authenticated as the GitHub App installation.
   * Gracefully falls back to GITHUB_ACCESS_TOKEN if App credentials are not present (for local testing).
   */
  public static async getInstallationOctokit(installationId?: string | number | null): Promise<Octokit> {
    if (installationId && (process.env.GITHUB_APP_ID && this.getPrivateKey())) {
      const token = await this.getInstallationToken(installationId);
      return new Octokit({ auth: token });
    }

    // Fallback for single-tenant local testing or backward compatibility
    const fallbackToken = process.env.GITHUB_ACCESS_TOKEN;
    if (fallbackToken) {
      return new Octokit({ auth: fallbackToken });
    }

    throw new Error('No valid GitHub authentication method configured (neither GitHub App nor GITHUB_ACCESS_TOKEN)');
  }

  /**
   * Returns a ready-to-use GitHubService instance for a specific installation.
   */
  public static async getInstallationService(installationId?: string | number | null): Promise<GitHubService> {
    if (installationId && (process.env.GITHUB_APP_ID && this.getPrivateKey())) {
      const token = await this.getInstallationToken(installationId);
      return new GitHubService(token);
    }

    const fallbackToken = process.env.GITHUB_ACCESS_TOKEN;
    if (fallbackToken) {
      return new GitHubService(fallbackToken);
    }

    throw new Error('Cannot initialize GitHubService: no installationId provided and no GITHUB_ACCESS_TOKEN found');
  }

  /**
   * Logs which authentication path is live so a missing App key is never silent.
   */
  public static logAuthMode(): void {
    const appId = process.env.GITHUB_APP_ID;
    const hasKey = Boolean(this.getPrivateKey());

    if (appId && hasKey) {
      console.log(`🔐 GitHub auth: App mode (App ID ${appId}) — multi-tenant enabled.`);
    } else if (process.env.GITHUB_ACCESS_TOKEN) {
      const missing = [
        !appId && 'GITHUB_APP_ID',
        !hasKey && 'GITHUB_APP_PRIVATE_KEY_PATH',
      ].filter(Boolean).join(' + ');
      console.warn(
        `⚠️  GitHub auth: PAT fallback — the GitHub App is NOT active (missing ${missing}).`,
      );
    } else {
      console.error('❌ GitHub auth: no App credentials and no GITHUB_ACCESS_TOKEN.');
    }
  }

  /**
   * Clears the token cache (useful for testing or forced revocation).
   */
  public static clearCache(): void {
    this.tokenCache.clear();
  }
}
