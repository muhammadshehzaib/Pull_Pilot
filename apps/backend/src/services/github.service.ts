import { Octokit } from '@octokit/rest';

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
  async createReviewComment(
    owner: string,
    repo: string,
    pullNumber: number,
    commitId: string,
    path: string,
    line: number,
    body: string,
  ) {
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
    } catch (err) {
      console.warn(`⚠️ Ignored failed comment injection to line ${line}:`, (err as Error).message);
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

  /**
   * Head commit SHA of the default branch — used by the repo poller to detect
   * pushes on webhook-less repos.
   */
  async getLatestCommitSha(owner: string, repo: string): Promise<string | undefined> {
    const { data } = await this.octokit.repos.listCommits({ owner, repo, per_page: 1 });
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
  async getFileContent(owner: string, repo: string, path: string, ref?: string): Promise<string | null> {
    try {
      const response = await this.octokit.repos.getContent({
        owner,
        repo,
        path,
        ...(ref ? { ref } : {}),
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
   * Posts a top-level issue / PR discussion comment (e.g. for overall review summary or quota notice).
   */
  async createIssueComment(owner: string, repo: string, issueNumber: number, body: string) {
    try {
      await this.octokit.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body,
      });
      console.log(`💬 Posted issue comment successfully to PR #${issueNumber}`);
    } catch (err) {
      console.warn(`⚠️ Failed to post issue comment to PR #${issueNumber}:`, (err as Error).message);
    }
  }
}

