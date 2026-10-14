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
  mockGetTree,
  mockGetBlob,
  mockListReviewComments,
  mockListIssueComments,
  mockGetAuthenticated,
  mockGetById,
  mockGetPermission,
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
  const mockGetTree = vi.fn();
  const mockGetBlob = vi.fn();
  const mockListReviewComments = vi.fn();
  const mockListIssueComments = vi.fn();
  const mockGetAuthenticated = vi.fn();
  const mockGetById = vi.fn();
  const mockGetPermission = vi.fn();

  const OctokitCtor = vi.fn(function (this: any, _opts?: unknown) {
    this.repos = {
      compareCommits: mockCompareCommits,
      createWebhook: mockCreateWebhook,
      deleteWebhook: mockDeleteWebhook,
      get: mockGetRepo,
      getCollaboratorPermissionLevel: mockGetPermission,
      getContent: mockGetContent,
    };
    this.pulls = {
      createReviewComment: mockCreateReviewComment,
      get: mockGetPullRequest,
      listReviewComments: mockListReviewComments,
    };
    this.issues = {
      createComment: mockCreateIssueComment,
      listComments: mockListIssueComments,
    };
    this.users = { getAuthenticated: mockGetAuthenticated, getById: mockGetById };
    this.git = {
      getTree: mockGetTree,
      getBlob: mockGetBlob,
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
    mockGetTree,
    mockGetBlob,
    mockListReviewComments,
    mockListIssueComments,
    mockGetAuthenticated,
    mockGetById,
    mockGetPermission,
    OctokitCtor,
  };
});

vi.mock('@octokit/rest', () => ({ Octokit: OctokitCtor }));

import { GitHubService } from './github.service';
import { Octokit } from '@octokit/rest';
import { RepositoryAccessError } from '../errors/repository-access.error';

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

  describe('getRepoForUser()', () => {
    beforeEach(() => {
      mockGetRepo.mockResolvedValue({ data: { id: 99, private: true, permissions: { admin: true } } });
      mockGetById.mockResolvedValue({ data: { id: 7, login: 'current-login' } });
      mockGetPermission.mockResolvedValue({ data: { user: { id: 7 }, permission: 'read' } });
    });

    it.each(['read', 'write', 'admin'])('accepts effective %s access, including team/org grants', async permission => {
      mockGetPermission.mockResolvedValueOnce({ data: { user: { id: 7 }, permission, role_name: 'custom-role' } });
      await expect(svc.getRepoForUser('company', 'private', '7')).resolves.toMatchObject({ id: 99 });
      expect(mockGetById).toHaveBeenCalledWith({ account_id: 7, request: expect.objectContaining({ timeout: 10_000 }) });
      expect(mockGetPermission).toHaveBeenCalledWith({ owner: 'company', repo: 'private', username: 'current-login', request: expect.any(Object) });
    });

    it('denies a stranger even when the server has admin access', async () => {
      mockGetPermission.mockResolvedValueOnce({ data: { user: { id: 7 }, permission: 'none' } });
      await expect(svc.getRepoForUser('company', 'private', '7')).rejects.toMatchObject({ status: 403 });
    });

    it.each([
      { user: { id: 8 }, permission: 'admin' },
      { permission: 'admin' },
      { user: { id: 7 }, permission: 'unexpected' },
    ])('denies malformed or mismatched permission evidence: %j', async data => {
      mockGetPermission.mockResolvedValueOnce({ data });
      await expect(svc.getRepoForUser('o', 'r', '7')).rejects.toBeInstanceOf(RepositoryAccessError);
    });

    it('uses the current login resolved from the stable ID, not a stale username', async () => {
      mockGetById.mockResolvedValueOnce({ data: { id: 7, login: 'renamed-user' } });
      await svc.getRepoForUser('o', 'r', '7');
      expect(mockGetPermission.mock.calls.at(-1)![0].username).toBe('renamed-user');
    });

    it('denies a mismatched GitHub profile before the permission request', async () => {
      mockGetById.mockResolvedValueOnce({ data: { id: 8, login: 'other-person' } });
      await expect(svc.getRepoForUser('o', 'r', '7')).rejects.toMatchObject({ status: 403 });
      expect(mockGetPermission).not.toHaveBeenCalled();
    });

    it.each(['', 'gh', '0', '-1', '7/path', '9007199254740992'])('denies invalid account ID %j', async id => {
      await expect(svc.getRepoForUser('o', 'r', id)).rejects.toMatchObject({ status: 403 });
      expect(mockGetRepo).not.toHaveBeenCalled();
    });

    it('allows a public repo without collaborator membership', async () => {
      mockGetRepo.mockResolvedValueOnce({ data: { id: 99, private: false } });
      await svc.getRepoForUser('o', 'r', '7');
      expect(mockGetPermission).not.toHaveBeenCalled();
      expect(mockGetById).not.toHaveBeenCalled();
    });

    it('still protects saved private reports after the repository becomes public', async () => {
      mockGetRepo.mockResolvedValueOnce({ data: { id: 99, private: false } });
      mockGetPermission.mockResolvedValueOnce({ data: { user: { id: 7 }, permission: 'none' } });
      await expect(svc.getRepoForUser('o', 'r', '7', { requireMembership: true })).rejects.toMatchObject({ status: 403 });
    });

    it('denies repository replacement at the same owner/name', async () => {
      await expect(svc.getRepoForUser('o', 'r', '7', { expectedRepoId: '100' })).rejects.toMatchObject({ status: 403 });
      expect(mockGetPermission).not.toHaveBeenCalled();
    });

    it('denies unknown repository visibility', async () => {
      mockGetRepo.mockResolvedValueOnce({ data: { id: 99 } });
      await expect(svc.getRepoForUser('o', 'r', '7')).rejects.toMatchObject({ status: 403 });
    });

    it.each([401, 403, 404, 429, 500])('fails closed with sanitized GitHub status %i', async status => {
      mockGetPermission.mockRejectedValueOnce(Object.assign(new Error('credential secret upstream details'), { status }));
      const unavailable = status >= 429;
      await expect(svc.getRepoForUser('o', 'r', '7')).rejects.toMatchObject({ status: unavailable ? 503 : 403,
        message: unavailable ? 'GitHub access verification is temporarily unavailable. Try again later.' :
          'GitHub repository access could not be confirmed for your account.' });
    });

    it('treats a 403 rate limit as temporary instead of permanently skipping reviews', async () => {
      mockGetPermission.mockRejectedValueOnce({ status: 403, response: { headers: { 'x-ratelimit-remaining': '0' } } });
      await expect(svc.getRepoForUser('o', 'r', '7')).rejects.toMatchObject({ status: 503 });
    });

    it('does not cache a previous grant after permission is revoked', async () => {
      await svc.getRepoForUser('o', 'r', '7');
      mockGetPermission.mockResolvedValueOnce({ data: { user: { id: 7 }, permission: 'none' } });
      await expect(svc.getRepoForUser('o', 'r', '7')).rejects.toMatchObject({ status: 403 });
      expect(mockGetPermission).toHaveBeenCalledTimes(2);
    });

    it('passes cancellation to every GitHub lookup', async () => {
      const signal = new AbortController().signal;
      await svc.getRepoForUser('o', 'r', '7', { signal });
      for (const mock of [mockGetRepo, mockGetById, mockGetPermission]) {
        expect(mock.mock.calls.at(-1)![0].request).toEqual({ timeout: 10_000, signal });
      }
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
        error: 'github-delivery-unconfirmed', failure: 'UNKNOWN', status: undefined,
      });
    });

    it('reports success', async () => {
      mockCreateReviewComment.mockResolvedValueOnce({ data: { id: 1 } });

      await expect(
        svc.createReviewComment('o', 'r', 42, 'sha', 'f.ts', 10, 'body'),
      ).resolves.toEqual({ ok: true, id: '1', url: undefined });
    });
  });

  describe('durable delivery API support', () => {
    const comment = (id: number) => ({ id, body: `marker-${id}`, user: { id: 7 }, html_url: `https://github.com/o/r/pull/42#${id}`,
      path: 'src/a.ts', original_commit_id: 'head' });
    beforeEach(() => { mockListReviewComments.mockReset(); mockListIssueComments.mockReset(); mockGetAuthenticated.mockReset(); });
    it('paginates raw inline comment bodies and keeps original commit identity', async () => {
      mockListReviewComments.mockResolvedValueOnce({ data: Array.from({ length: 100 }, (_, i) => comment(i + 1)) })
        .mockResolvedValueOnce({ data: [comment(101)] });
      const result = await svc.listDeliveryComments('o', 'r', 42, 'INLINE', new AbortController().signal);
      expect(result.complete).toBe(true); expect(result.comments).toHaveLength(101);
      expect(result.comments[100]).toMatchObject({ id: '101', authorId: '7', originalCommitId: 'head', body: 'marker-101' });
      expect(mockListReviewComments).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, per_page: 100,
        headers: { accept: 'application/vnd.github.raw+json' }, request: expect.objectContaining({ timeout: expect.any(Number) }) }));
    });
    it('preserves positive results when a subsequent page fails', async () => {
      mockListIssueComments.mockResolvedValueOnce({ data: Array.from({ length: 100 }, (_, i) => comment(i)) })
        .mockRejectedValueOnce(new Error('rate limited'));
      const result = await svc.listDeliveryComments('o', 'r', 42, 'SUMMARY');
      expect(result.complete).toBe(false); expect(result.comments).toHaveLength(100);
    });
    it('caps scans at 20 pages and reports incomplete discovery', async () => {
      mockListReviewComments.mockResolvedValue({ data: Array.from({ length: 100 }, (_, i) => comment(i)) });
      const result = await svc.listDeliveryComments('o', 'r', 42, 'INLINE');
      expect(result.complete).toBe(false); expect(mockListReviewComments).toHaveBeenCalledTimes(20);
    });
    it('does not start a request after cancellation', async () => {
      const abort = new AbortController(); abort.abort();
      expect(await svc.listDeliveryComments('o', 'r', 42, 'INLINE', abort.signal)).toEqual({ comments: [], complete: false });
      expect(mockListReviewComments).not.toHaveBeenCalled();
    });
    it('returns the PAT actor numeric ID and refuses a missing identity', async () => {
      mockGetAuthenticated.mockResolvedValueOnce({ data: { id: 7 } }).mockResolvedValueOnce({ data: {} });
      expect(await svc.getPostingAuthorId()).toBe('7');
      await expect(svc.getPostingAuthorId()).rejects.toThrow('unavailable');
    });
    it('returns successful GitHub receipt IDs and never retries ambiguous creation', async () => {
      mockCreateReviewComment.mockResolvedValueOnce({ data: { id: 9, html_url: 'https://github.com/o/r/pull/42#9' } });
      expect(await svc.createReviewComment('o', 'r', 42, 'head', 'src/a.ts', 1, 'body')).toEqual({ ok: true, id: '9', url: 'https://github.com/o/r/pull/42#9' });
      mockCreateReviewComment.mockClear();
      mockCreateReviewComment.mockRejectedValueOnce(Object.assign(new Error('lost response'), { status: 502 }));
      expect(await svc.createReviewComment('o', 'r', 42, 'head', 'src/a.ts', 1, 'body')).toMatchObject({ failure: 'UNKNOWN' });
      expect(mockCreateReviewComment).toHaveBeenCalledOnce();
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

  describe('getTree()', () => {
    it('requests a recursive listing for the given sha', async () => {
      mockGetTree.mockResolvedValueOnce({ data: { tree: [], truncated: false } });

      await svc.getTree('o', 'r', 'headsha123');

      expect(mockGetTree).toHaveBeenCalledWith({
        owner: 'o',
        repo: 'r',
        tree_sha: 'headsha123',
        recursive: 'true',
      });
    });

    it('keeps only blobs, skipping trees and submodule gitlinks', async () => {
      mockGetTree.mockResolvedValueOnce({
        data: {
          truncated: false,
          tree: [
            { type: 'tree', path: 'src', sha: 'tree1' },
            { type: 'blob', path: 'src/a.ts', sha: 'blobA', size: 120, mode: '100644' },
            { type: 'commit', path: 'vendor/lib', sha: 'sub1' },
            { type: 'blob', path: 'README.md', sha: 'blobB', size: 40, mode: '100644' },
          ],
        },
      });

      const tree = await svc.getTree('o', 'r', 'sha');

      expect(tree?.files.map((f) => f.path)).toEqual(['src/a.ts', 'README.md']);
      expect(tree?.files[0]).toEqual({
        path: 'src/a.ts',
        blobSha: 'blobA',
        size: 120,
        mode: '100644',
      });
    });

    it('reports truncation so callers do not treat a partial map as complete', async () => {
      mockGetTree.mockResolvedValueOnce({ data: { tree: [], truncated: true } });

      const tree = await svc.getTree('o', 'r', 'sha');

      expect(tree?.truncated).toBe(true);
    });

    it('defaults size to 0 when the entry omits it', async () => {
      mockGetTree.mockResolvedValueOnce({
        data: { truncated: false, tree: [{ type: 'blob', path: 'a.ts', sha: 's', mode: '100644' }] },
      });

      const tree = await svc.getTree('o', 'r', 'sha');

      expect(tree?.files[0].size).toBe(0);
    });

    it('returns null on a bad sha rather than an empty inventory', async () => {
      mockGetTree.mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }));

      await expect(svc.getTree('o', 'r', 'bogus')).resolves.toBeNull();
    });

    it('rethrows unexpected errors so a transient failure is not silently empty', async () => {
      mockGetTree.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));

      await expect(svc.getTree('o', 'r', 'sha')).rejects.toThrow('boom');
    });
  });

  describe('getBlob()', () => {
    it('accepts a genuinely empty source file and enforces the actual decoded byte limit', async () => {
      mockGetBlob.mockResolvedValueOnce({ data: { size: 0, content: '', encoding: 'base64' } });
      await expect(svc.getBlob('o', 'r', 'empty', undefined, 5)).resolves.toBe('');
      mockGetBlob.mockResolvedValueOnce({ data: { content: Buffer.from('123456').toString('base64'), encoding: 'base64' } });
      await expect(svc.getBlob('o', 'r', 'six', undefined, 5)).resolves.toBeNull();
    });
    it('forwards cancellation and refuses decoded payloads above the requested size', async () => {
      const signal = new AbortController().signal;
      mockGetBlob.mockResolvedValueOnce({ data: { size: 10, content: Buffer.from('1234567890').toString('base64'), encoding: 'base64' } });
      await expect(svc.getBlob('o', 'r', 'large', signal, 5)).resolves.toBeNull();
      expect(mockGetBlob).toHaveBeenCalledWith({ owner: 'o', repo: 'r', file_sha: 'large', request: { signal, timeout: 10_000 } });
    });
    it('decodes base64 content by sha', async () => {
      mockGetBlob.mockResolvedValueOnce({
        data: { content: Buffer.from('const x = 1;').toString('base64'), encoding: 'base64' },
      });

      await expect(svc.getBlob('o', 'r', 'blobA')).resolves.toBe('const x = 1;');
      expect(mockGetBlob).toHaveBeenCalledWith({ owner: 'o', repo: 'r', file_sha: 'blobA' });
    });

    it('handles content that needs multi-byte utf-8 decoding', async () => {
      mockGetBlob.mockResolvedValueOnce({
        data: { content: Buffer.from('const emoji = "🎯";', 'utf8').toString('base64'), encoding: 'base64' },
      });

      await expect(svc.getBlob('o', 'r', 'blobB')).resolves.toContain('🎯');
    });

    it('refuses a non-base64 encoding instead of returning garbage', async () => {
      mockGetBlob.mockResolvedValueOnce({ data: { content: 'raw', encoding: 'utf-8' } });

      await expect(svc.getBlob('o', 'r', 'blobC')).resolves.toBeNull();
    });

    it('returns null when the blob is missing', async () => {
      mockGetBlob.mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }));

      await expect(svc.getBlob('o', 'r', 'gone')).resolves.toBeNull();
    });
  });
});
