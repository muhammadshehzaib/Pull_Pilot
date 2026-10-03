import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.mock is hoisted — use vi.hoisted() so referenced symbols exist at hoist time.
const {
  mockCompareCommits,
  mockCreateReviewComment,
  mockCreateWebhook,
  mockDeleteWebhook,
  mockGetRepo,
  mockGetPullRequest,
  mockGetContent,
  mockCreateIssueComment,
  OctokitCtor,
} = vi.hoisted(() => {
  const mockCompareCommits = vi.fn();
  const mockCreateReviewComment = vi.fn();
  const mockCreateWebhook = vi.fn();
  const mockDeleteWebhook = vi.fn();
  const mockGetRepo = vi.fn();
  const mockGetPullRequest = vi.fn();
  const mockGetContent = vi.fn();
  const mockCreateIssueComment = vi.fn();

  const OctokitCtor = vi.fn(function (this: any, _opts?: unknown) {
    this.repos = {
      compareCommits: mockCompareCommits,
      createWebhook: mockCreateWebhook,
      deleteWebhook: mockDeleteWebhook,
      get: mockGetRepo,
      getContent: mockGetContent,
    };
    this.pulls = {
      createReviewComment: mockCreateReviewComment,
      get: mockGetPullRequest,
    };
    this.issues = {
      createComment: mockCreateIssueComment,
    };
  });

  return {
    mockCompareCommits,
    mockCreateReviewComment,
    mockCreateWebhook,
    mockDeleteWebhook,
    mockGetRepo,
    mockGetPullRequest,
    mockGetContent,
    mockCreateIssueComment,
    OctokitCtor,
  };
});

vi.mock('@octokit/rest', () => ({ Octokit: OctokitCtor }));

import { GitHubService } from './github.service';
import { Octokit } from '@octokit/rest';

describe('GitHubService', () => {
  let svc: GitHubService;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = new GitHubService('ghp_test_token_abc123');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('initializes Octokit with the provided token', () => {
      new GitHubService('ghp_xyz');
      expect(Octokit).toHaveBeenCalledWith({ auth: 'ghp_xyz' });
    });
  });

  describe('fetchDiff() — happy path', () => {
    it('returns the diff string returned by Octokit', async () => {
      const fakeDiff = 'diff --git a/foo.ts b/foo.ts\n+ added';
      mockCompareCommits.mockResolvedValueOnce({ data: fakeDiff });

      const out = await svc.fetchDiff('owner', 'repo', 'main', 'feature');

      expect(out).toBe(fakeDiff);
      expect(mockCompareCommits).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        base: 'main',
        head: 'feature',
        headers: { accept: 'application/vnd.github.v3.diff' },
      });
    });

    it('passes through an empty diff (no changes case)', async () => {
      mockCompareCommits.mockResolvedValueOnce({ data: '' });
      await expect(svc.fetchDiff('o', 'r', 'a', 'b')).resolves.toBe('');
    });
  });

  describe('fetchDiff() — failure path', () => {
    it('wraps any Octokit error into a generic message (does not leak internals)', async () => {
      mockCompareCommits.mockRejectedValueOnce(new Error('401 Bad credentials'));

      await expect(svc.fetchDiff('o', 'r', 'a', 'b')).rejects.toThrow(
        'Failed to extract diff from GitHub API',
      );
    });

    it('throws when the API responds with a 404 (e.g., repo not found)', async () => {
      mockCompareCommits.mockRejectedValueOnce(
        Object.assign(new Error('Not Found'), { status: 404 }),
      );
      await expect(svc.fetchDiff('o', 'r', 'a', 'b')).rejects.toThrow(/Failed to extract diff/);
    });
  });

  describe('createReviewComment()', () => {
    it('calls Octokit with side=RIGHT and all expected fields', async () => {
      mockCreateReviewComment.mockResolvedValueOnce({ data: { id: 1 } });

      await svc.createReviewComment('o', 'r', 42, 'sha-abc', 'src/foo.ts', 10, 'Fix this');

      expect(mockCreateReviewComment).toHaveBeenCalledWith({
        owner: 'o',
        repo: 'r',
        pull_number: 42,
        commit_id: 'sha-abc',
        path: 'src/foo.ts',
        line: 10,
        body: 'Fix this',
        side: 'RIGHT',
      });
    });

    it('reports failure instead of throwing — never break the run for one bad comment', async () => {
      mockCreateReviewComment.mockRejectedValueOnce(
        new Error('Unprocessable Entity: pull_request_review_thread.line invalid'),
      );

      const result = await svc.createReviewComment('o', 'r', 42, 'sha', 'f.ts', 999999, 'body');

      // Must not throw, but must report so the worker can surface it.
      expect(result).toEqual({
        ok: false,
        error: 'Unprocessable Entity: pull_request_review_thread.line invalid',
      });
    });

    it('reports success', async () => {
      mockCreateReviewComment.mockResolvedValueOnce({ data: { id: 1 } });

      await expect(
        svc.createReviewComment('o', 'r', 42, 'sha', 'f.ts', 10, 'body'),
      ).resolves.toEqual({ ok: true });
    });
  });

  describe('getFileContent()', () => {
    it('decodes base64 content returned by Octokit', async () => {
      const rawText = 'version: 1\nmin_severity: "high"';
      const base64Content = Buffer.from(rawText).toString('base64');
      mockGetContent.mockResolvedValueOnce({
        data: {
          type: 'file',
          content: base64Content,
        },
      });

      const content = await svc.getFileContent('owner', 'repo', '.aipr.yml', 'main');
      expect(content).toBe(rawText);
      expect(mockGetContent).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        path: '.aipr.yml',
        ref: 'main',
      });
    });

    it('returns null on 404 error without throwing', async () => {
      mockGetContent.mockRejectedValueOnce({ status: 404, message: 'Not Found' });
      const content = await svc.getFileContent('owner', 'repo', '.aipr.yml');
      expect(content).toBeNull();
    });
  });

  describe('createIssueComment()', () => {
    it('creates an issue/PR comment with the body', async () => {
      mockCreateIssueComment.mockResolvedValueOnce({ data: { id: 777 } });

      await svc.createIssueComment('owner', 'repo', 12, 'Summary report');
      expect(mockCreateIssueComment).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 12,
        body: 'Summary report',
      });
    });
  });

  describe('createWebhook()', () => {
    it('creates a webhook with secret and returns the hook id as a string', async () => {
      mockCreateWebhook.mockResolvedValueOnce({ data: { id: 12345 } });

      const hookId = await svc.createWebhook(
        'o',
        'r',
        'https://example.com/hook',
        'my-secret',
      );

      expect(hookId).toBe('12345');
      expect(mockCreateWebhook).toHaveBeenCalledWith({
        owner: 'o',
        repo: 'r',
        events: ['pull_request', 'push'],
        active: true,
        config: {
          url: 'https://example.com/hook',
          content_type: 'json',
          secret: 'my-secret',
          insecure_ssl: '0',
        },
      });
    });

    it('omits the secret key from config when not provided', async () => {
      mockCreateWebhook.mockResolvedValueOnce({ data: { id: 1 } });

      await svc.createWebhook('o', 'r', 'https://example.com/hook', undefined);

      const callArg = mockCreateWebhook.mock.calls[0][0];
      expect(callArg.config).not.toHaveProperty('secret');
      expect(callArg.config.url).toBe('https://example.com/hook');
    });

    it('propagates errors from the API (unlike createReviewComment)', async () => {
      mockCreateWebhook.mockRejectedValueOnce(new Error('Hook limit reached'));
      await expect(
        svc.createWebhook('o', 'r', 'https://e.com/h', 's'),
      ).rejects.toThrow(/Hook limit/);
    });
  });

  describe('deleteWebhook()', () => {
    it('calls Octokit with numeric hook_id', async () => {
      mockDeleteWebhook.mockResolvedValueOnce({});
      await svc.deleteWebhook('o', 'r', 99);
      expect(mockDeleteWebhook).toHaveBeenCalledWith({
        owner: 'o',
        repo: 'r',
        hook_id: 99,
      });
    });

    it('propagates a not-found error', async () => {
      mockDeleteWebhook.mockRejectedValueOnce(new Error('404 Hook gone'));
      await expect(svc.deleteWebhook('o', 'r', 99)).rejects.toThrow();
    });
  });

  describe('getRepo()', () => {
    it('returns repo data on success', async () => {
      mockGetRepo.mockResolvedValueOnce({ data: { id: 555, name: 'my-repo' } });
      const data = await svc.getRepo('o', 'r');
      expect(data.id).toBe(555);
    });
  });

  describe('getPullRequest()', () => {
    it('returns PR data on success', async () => {
      mockGetPullRequest.mockResolvedValueOnce({
        data: { number: 7, head: { sha: 'deadbeef' } },
      });
      const data = await svc.getPullRequest('o', 'r', 7);
      expect(data.head.sha).toBe('deadbeef');
    });

    it('propagates a not-found error when the PR does not exist', async () => {
      mockGetPullRequest.mockRejectedValueOnce(new Error('Not Found'));
      await expect(svc.getPullRequest('o', 'r', 999)).rejects.toThrow();
    });
  });
});
