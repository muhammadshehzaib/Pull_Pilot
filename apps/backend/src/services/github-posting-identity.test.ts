import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { getApp, getBot } = vi.hoisted(() => ({ getApp: vi.fn(), getBot: vi.fn() }));
vi.mock('@octokit/rest', () => ({ Octokit: vi.fn(function(this: any) {
  this.apps = { getAuthenticated: getApp };
  this.users = { getByUsername: getBot };
}) }));
import { GitHubAppService } from './github-app.service';
beforeEach(() => {
  vi.stubEnv('GITHUB_APP_ID', '123');
  vi.spyOn(GitHubAppService, 'getPrivateKey').mockReturnValue('test-only');
  vi.spyOn(GitHubAppService, 'generateAppJwt').mockReturnValue('jwt-test-only');
  vi.spyOn(GitHubAppService, 'getInstallationToken').mockResolvedValue('installation-token-test-only');
  getApp.mockResolvedValue({ data: { id: 123, slug: 'review-app' } });
  getBot.mockResolvedValue({ data: { id: 7, type: 'Bot' } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetAllMocks(); });
describe('trusted GitHub App posting identity', () => {
  it('derives the bot ID from the authenticated app rather than trusting a comment author', async () => {
    const gh = await GitHubAppService.getInstallationService('42');
    expect(await gh.getPostingAuthorId()).toBe('7');
    expect(getBot).toHaveBeenCalledWith(expect.objectContaining({ username: 'review-app[bot]' }));
  });
  it('refuses a mismatched authenticated app', async () => {
    getApp.mockResolvedValue({ data: { id: 999, slug: 'other-app' } });
    const gh = await GitHubAppService.getInstallationService('42');
    await expect(gh.getPostingAuthorId()).rejects.toThrow('identity unavailable');
    expect(getBot).not.toHaveBeenCalled();
  });
  it.each([{ id: 7, type: 'User' }, { type: 'Bot' }])('refuses an unverified bot identity', async bot => {
    getBot.mockResolvedValue({ data: bot });
    const gh = await GitHubAppService.getInstallationService('42');
    await expect(gh.getPostingAuthorId()).rejects.toThrow('identity unavailable');
  });
});
