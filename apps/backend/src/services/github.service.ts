import { Octokit } from '@octokit/rest';

/** Outcome of a comment post. Comment posting never throws; it reports. */
export interface CommentPostResult {
  ok: boolean;
  error?: string;
}

/** One file from a repository tree listing. */
export interface RepoTreeEntry {
  path: string;
  /** Git blob SHA. Content-addressed, so this is the cache key. */
  blobSha: string;
  size: number;
  mode: string;
}

export interface RepoTreeResult {
  files: RepoTreeEntry[];
  /** True when GitHub cut the listing short; the map is then incomplete. */
  truncated: boolean;
}

export class GitHubService {
  private octokit: Octokit;

  constructor(githubToken: string) {
    this.octokit = new Octokit({ auth: githubToken });
  }

  /**
   * Fetches the combined code diff between two commits or base/head of a PR.
   */
  async fetchDiff(owner: string, repo: string, base: string, head: string): Promise<string> {
    try {
      console.log(`📦 Fetching Diff: ${owner}/${repo} (Comparing ${base} -> ${head})`);

      const { data } = await this.octokit.repos.compareCommits({
        owner,
        repo,
        base,
        head,
        headers: {
          accept: 'application/vnd.github.v3.diff',
        },
      });

      return data as unknown as string;
    } catch (error) {
      console.error('🔴 GitHub Diff Fetch Failure:', error);
      throw new Error('Failed to extract diff from GitHub API');
    }
  }

  /**
   * Places persistent constructive criticism directly onto specific lines within a PR.
   */
  /**
   * Posts an inline review comment.
   *
   * A single comment can be rejected for reasons outside our control (GitHub
   * returns 422 when the line is not part of the diff, when the file was
   * renamed, or when the head SHA is stale). Failing the whole review for one
   * bad comment would be worse than skipping it, so this never throws — but it
   * reports the outcome so the caller can surface partial failures instead of
   * silently claiming success.
   */
  async createReviewComment(
    owner: string,
    repo: string,
    pullNumber: number,
    commitId: string,
    path: string,
    line: number,
    body: string,
  ): Promise<CommentPostResult> {
    try {
      await this.octokit.pulls.createReviewComment({
        owner,
        repo,
        pull_number: pullNumber,
        commit_id: commitId,
        path,
        line,
        body,
        side: 'RIGHT',
      });
      console.log(`💬 Posted comment successfully to line ${line} of ${path}`);
      return { ok: true };
    } catch (err) {
      const message = (err as Error).message;
      console.warn(`⚠️ Could not post inline comment at ${path}:${line} — ${message}`);
      return { ok: false, error: message };
    }
  }

  /**
   * Registers a webhook on the repo pointing back at our ingestion endpoint.
   * Returns the GitHub-assigned hook id (as a string) so we can later delete it.
   */
  async createWebhook(
    owner: string,
    repo: string,
    webhookUrl: string,
    secret: string | undefined,
  ): Promise<string> {
    const { data } = await this.octokit.repos.createWebhook({
      owner,
      repo,
      events: ['pull_request', 'push'],
      active: true,
      config: {
        url: webhookUrl,
        content_type: 'json',
        ...(secret ? { secret } : {}),
        insecure_ssl: '0',
      },
    });
    return String(data.id);
  }

  async deleteWebhook(owner: string, repo: string, hookId: number) {
    await this.octokit.repos.deleteWebhook({ owner, repo, hook_id: hookId });
  }

  /**
   * Looks up basic repo metadata (used to capture the numeric github repo id at registration time).
   */
  async getRepo(owner: string, repo: string) {
    const { data } = await this.octokit.repos.get({ owner, repo });
    return data;
  }

  /**
   * Resolves the head SHA for a pull request — used by the manual-trigger flow,
   * which doesn't have a webhook payload to read from.
   */
  async getPullRequest(owner: string, repo: string, pullNumber: number) {
    const { data } = await this.octokit.pulls.get({ owner, repo, pull_number: pullNumber });
    return data;
  }

  async getDeploymentPreview(owner: string, repo: string, deploymentId: number) {
    const [{ data: deployment }, { data: statuses }] = await Promise.all([
      this.octokit.repos.getDeployment({ owner, repo, deployment_id: deploymentId }),
      this.octokit.repos.listDeploymentStatuses({ owner, repo, deployment_id: deploymentId, per_page: 1 }),
    ]);
    const status = statuses[0];
    return { sha: deployment.sha, environment: deployment.environment, state: status?.state,
      url: status?.environment_url, publisher: status?.creator?.login };
  }

  async dispatchBehavioralWorkflow(owner: string, repo: string, ref: string, runId: string, dispatchToken: string) {
    await this.octokit.actions.createWorkflowDispatch({ owner, repo,
      workflow_id: 'aipr-behavioral.yml', ref,
      inputs: { run_id: runId, dispatch_token: dispatchToken } });
  }

  /**
   * Head commit SHA of the default branch — used by the repo poller to detect
   * pushes on webhook-less repos.
   */
  async getLatestCommitSha(
    owner: string,
    repo: string,
    branch?: string,
  ): Promise<string | undefined> {
    const { data } = await this.octokit.repos.listCommits({
      owner,
      repo,
      ...(branch ? { sha: branch } : {}),
      per_page: 1,
    });
    return data[0]?.sha;
  }

  /**
   * Resolves the latest commit and its parent on a given branch (or repo default branch).
   * Automatically falls back between 'main' and 'master' if needed.
   */
  async getLatestCommitWithParent(
    owner: string,
    repo: string,
    branchOrSha?: string
  ): Promise<{ headSha: string; baseSha: string; branch: string }> {
    let targetBranch = branchOrSha?.trim();
    let defaultBranch = 'main';

    try {
      const repoData = await this.getRepo(owner, repo);
      defaultBranch = repoData.default_branch || 'main';
    } catch {
      // fallback
    }

    if (!targetBranch) {
      targetBranch = defaultBranch;
    }

    const tryFetch = async (branchRef: string) => {
      const { data } = await this.octokit.repos.listCommits({
        owner,
        repo,
        sha: branchRef,
        per_page: 1,
      });
      if (data && data[0]) {
        return {
          headSha: data[0].sha,
          baseSha: data[0].parents && data[0].parents[0] ? data[0].parents[0].sha : `${data[0].sha}~1`,
          branch: branchRef,
        };
      }
      return null;
    };

    try {
      const result = await tryFetch(targetBranch);
      if (result) return result;
    } catch (err: any) {
      // If 404 and target was 'main', retry with defaultBranch or 'master'
      if (targetBranch !== defaultBranch) {
        try {
          const fallbackResult = await tryFetch(defaultBranch);
          if (fallbackResult) return fallbackResult;
        } catch {
          // ignore
        }
      }
      throw err;
    }

    throw new Error(`No commits found for repository ${owner}/${repo}`);
  }

  /**
   * Most recently updated open PRs — used by the repo poller to review fresh
   * commits on the connected user's pull requests.
   */
  async listOpenPullRequests(owner: string, repo: string) {
    const { data } = await this.octokit.pulls.list({
      owner,
      repo,
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: 10,
    });
    return data;
  }

  /**
   * Fetches raw content of a file from a repository at a specific branch/ref.
   * Returns null if the file does not exist (404).
   */
  async getFileContent(owner: string, repo: string, path: string, ref?: string, signal?: AbortSignal): Promise<string | null> {
    try {
      const response = await this.octokit.repos.getContent({
        owner,
        repo,
        path,
        ...(ref ? { ref } : {}),
        ...(signal ? { request: { signal, timeout: 10_000 } } : {}),
      });

      if ('content' in response.data && typeof response.data.content === 'string') {
        return Buffer.from(response.data.content, 'base64').toString('utf-8');
      }
      return null;
    } catch (err: any) {
      if (err.status === 404 || err?.response?.status === 404) {
        return null;
      }
      console.warn(`⚠️ Failed to retrieve ${path} from ${owner}/${repo}:`, err.message);
      return null;
    }
  }

  /**
   * Lists every file in the repo at a given commit: one recursive Trees call.
   *
   * This is the inventory step for context-aware reviews. It returns paths and
   * blob SHAs but no file contents, so a whole-repo map costs a single request
   * instead of one per file. Contents are fetched separately via getBlob().
   *
   * GitHub truncates recursive trees for very large repos; when that happens
   * `truncated` is true and the caller must not assume the listing is
   * complete, or context retrieval will quietly miss neighbours.
   */
  async getTree(owner: string, repo: string, sha: string, signal?: AbortSignal): Promise<RepoTreeResult | null> {
    try {
      const { data } = await this.octokit.git.getTree({
        owner,
        repo,
        tree_sha: sha,
        recursive: 'true',
        ...(signal ? { request: { signal, timeout: 10_000 } } : {}),
      });

      const files: RepoTreeEntry[] = [];
      for (const node of data.tree) {
        if (node.type !== 'blob' || !node.sha) continue;
        files.push({
          path: node.path,
          blobSha: node.sha,
          // Only set for symlinks and (for submodules) gitlinks; both are
          // skipped during import resolution rather than parsed as source.
          size: node.size ?? 0,
          mode: node.mode ?? '',
        });
      }

      return { files, truncated: data.truncated === true };
    } catch (err: any) {
      const status = err.status ?? err?.response?.status;
      console.warn(`⚠️ Failed to list tree for ${owner}/${repo}@${sha}:`, err.message);
      // 404 means a bad/missing SHA; surface it as "no inventory" rather than
      // letting context look like an empty repository.
      if (status === 404 || status === 409) return null;
      throw err;
    }
  }

  /**
   * Fetches one file's content by blob SHA.
   *
   * Addressing by SHA (not path) is what makes caching work: the same blob
   * returns the same SHA at every commit it appears in, so an unchanged file is
   * fetched once and then served from the cache.
   */
  async getBlob(owner: string, repo: string, blobSha: string, signal?: AbortSignal, maxBytes?: number): Promise<string | null> {
    try {
      const { data } = await this.octokit.git.getBlob({ owner, repo, file_sha: blobSha,
        ...(signal ? { request: { signal, timeout: 10_000 } } : {}) });

      if (typeof data.content !== 'string') return null;
      if (data.encoding !== 'base64') {
        console.warn(`⚠️ Unexpected blob encoding "${data.encoding}" for ${blobSha}; skipping`);
        return null;
      }
      if (maxBytes !== undefined && ((data.size ?? 0) > maxBytes || data.content.replace(/\s/g, '').length > Math.ceil(maxBytes / 3) * 4)) return null;
      const decoded = Buffer.from(data.content, 'base64');
      if (maxBytes !== undefined && decoded.length > maxBytes) return null;
      return decoded.toString('utf-8');
    } catch (err: any) {
      const status = err.status ?? err?.response?.status;
      if (status === 404) return null;
      console.warn(`⚠️ Failed to retrieve blob ${blobSha} from ${owner}/${repo}:`, err.message);
      return null;
    }
  }

  /**
   * Posts a top-level issue / PR discussion comment (e.g. for overall review summary or quota notice).
   */
  async createIssueComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<CommentPostResult> {
    try {
      await this.octokit.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body,
      });
      console.log(`💬 Posted issue comment successfully to PR #${issueNumber}`);
      return { ok: true };
    } catch (err) {
      const message = (err as Error).message;
      console.warn(`⚠️ Failed to post issue comment to PR #${issueNumber}: ${message}`);
      return { ok: false, error: message };
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Test-draft PR plumbing                                                   */
  /*                                                                          */
  /* These back the "create a test PR" flow. They are deliberately explicit   */
  /* and few: a branch, a file write, a PR lookup and a PR create. Each is    */
  /* idempotent-friendly so a retried request cannot create duplicates.       */
  /* ---------------------------------------------------------------------- */

  /**
   * Head commit SHA of a branch, or null when the branch does not exist.
   *
   * Used both to read the current base (for staleness detection) and to test
   * whether our draft branch already exists on retry.
   */
  async getBranchHeadSha(owner: string, repo: string, branch: string): Promise<string | null> {
    try {
      const { data } = await this.octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${branch}`,
      });
      return data.object.sha;
    } catch (err: any) {
      const status = err.status ?? err?.response?.status;
      if (status === 404) return null;
      throw err;
    }
  }

  /** Creates a branch pointing at `sha`. Assumes it does not already exist. */
  async createBranch(owner: string, repo: string, branch: string, sha: string): Promise<void> {
    await this.octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha,
    });
  }

  /**
   * Creates or updates a file on `branch` and returns the resulting commit SHA.
   *
   * Existing files need their blob SHA in the update payload, so the current
   * file is looked up first. A 404 simply means "create".
   */
  async upsertFile(
    owner: string,
    repo: string,
    path: string,
    content: string,
    message: string,
    branch: string,
  ): Promise<string> {
    let existingSha: string | undefined;
    try {
      const { data } = await this.octokit.repos.getContent({ owner, repo, path, ref: branch });
      if (!Array.isArray(data) && 'sha' in data) existingSha = data.sha;
    } catch (err: any) {
      const status = err.status ?? err?.response?.status;
      if (status !== 404) throw err;
    }

    const { data } = await this.octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      message,
      content: Buffer.from(content, 'utf-8').toString('base64'),
      branch,
      ...(existingSha ? { sha: existingSha } : {}),
    });

    return data.commit.sha ?? '';
  }

  /**
   * Finds an open PR whose head is `owner:branch`, or null.
   *
   * This is the idempotency guard: before opening a PR we check whether a
   * previous attempt already opened one for the same draft branch.
   */
  async findPullRequestByHead(
    owner: string,
    repo: string,
    head: string,
    base?: string,
  ): Promise<{ number: number; htmlUrl: string } | null> {
    const { data } = await this.octokit.pulls.list({
      owner,
      repo,
      head,
      // Include closed PRs too: a retry after a successful create (but a lost
      // response/database write) must not open a second PR for this draft.
      state: 'all',
      per_page: 10,
      ...(base ? { base } : {}),
    });
    const pr = data[0];
    return pr ? { number: pr.number, htmlUrl: pr.html_url } : null;
  }

  /** Opens a pull request and returns its number and URL. */
  async createPullRequest(
    owner: string,
    repo: string,
    title: string,
    head: string,
    base: string,
    body: string,
  ): Promise<{ number: number; htmlUrl: string }> {
    const { data } = await this.octokit.pulls.create({
      owner,
      repo,
      title,
      head,
      base,
      body,
    });
    return { number: data.number, htmlUrl: data.html_url };
  }
}

