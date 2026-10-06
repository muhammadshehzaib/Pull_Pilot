import { GitHubService } from './github.service';
import { RepositoryContextCache } from './repository-context-cache.service';
import { selectContextFiles } from './context-retrieval.service';
import { parsePathAliases, type PathAliases } from './import-graph.service';
import type { ContextConfig } from './config.service';
import type { ContextFile, ReviewContext } from './ai/context-prompt';

/** How many blob reads run at once. Keeps a cold repo off the rate limit. */
const BLOB_CONCURRENCY = 4;

/** tsconfig locations tried when building the import graph. */
const TSCONFIG_PATHS = ['tsconfig.json', 'packages/tsconfig.json'];

export interface BuildReviewContextInput {
  ghService: GitHubService;
  owner: string;
  repo: string;
  repositoryId: string;
  headSha: string;
  changedPaths: string[];
  config: ContextConfig;
  cache?: RepositoryContextCache;
}

/**
 * Assembles the context block for one review, or returns undefined.
 *
 * This is the orchestration layer: it owns the tree listing, the cache, the
 * lazy neighbour walk, and the tsconfig aliases, while each of those lives in
 * a service that does one thing.
 *
 * The walk is lazy on purpose. Discovering a hop-2 neighbour requires reading
 * the hop-1 file that imports it, so a walk that eagerly read the whole
 * repository would spend one API call per file to answer a question about a
 * handful. Instead it fetches a round, expands, and stops as soon as the
 * budget is met.
 *
 * Failure is always safe. Any error degrades to a diff-only review, because a
 * review without extra context is far better than a review that did not run.
 */
export async function buildReviewContext(
  input: BuildReviewContextInput,
): Promise<ReviewContext | undefined> {
  const { ghService, owner, repo, repositoryId, headSha, changedPaths, config, cache } = input;

  if (!config.enabled || changedPaths.length === 0) return undefined;

  const store = cache ?? new RepositoryContextCache();

  try {
    // One listing gives every path, its blob SHA (the cache key), and whether
    // GitHub truncated it.
    const tree = await ghService.getTree(owner, repo, headSha);
    if (!tree) return undefined;

    const shaByPath = new Map<string, string>();
    for (const file of tree.files) shaByPath.set(file.path, file.blobSha);

    // Only source files can contribute edges or context, so narrow the
    // inventory before fetching anything. A repo with 400 lockfiles and
    // screenshots becomes a much smaller problem here.
    const allPaths = [...shaByPath.keys()].filter((path) =>
      RepositoryContextCache.isContextCandidate(path, 0),
    );

    const changed = changedPaths.filter((path) => shaByPath.has(path));
    if (changed.length === 0) return undefined;

    const aliases = await loadAliases(ghService, owner, repo, headSha);
    const contents = new Map<string, string>();

    // Round 0 reads the changed files: with no content there is no graph.
    let incomplete = !(await loadContents(
      ghService,
      store,
      owner,
      repo,
      repositoryId,
      shaByPath,
      changed,
      contents,
    ));

    // Each further round reads the neighbours the previous round discovered,
    // which is what turns "these import the change" into "two hops away".
    // The loop must run once per hop: round 1 fetches hop-1 files, round 2
    // then discovers and fetches hop-2. Stopping one short would discover the
    // farthest files but never read them, leaving them out of context.
    for (let round = 1; round <= config.max_hops; round++) {
      const walk = selectContextFiles({
        changedPaths: changed,
        contents,
        allPaths,
        aliases,
        maxHops: round,
        maxFiles: config.max_files,
      });

      const needed = walk.candidates
        .map((c) => c.path)
        .filter((path) => !contents.has(path));
      if (needed.length === 0) break;

      // The budget counts neighbour slots, not changed files: changed files
      // are already in the diff and are never sent as context.
      const batch = needed.slice(0, config.max_files);
      if (batch.length === 0) break;

      const ok = await loadContents(
        ghService,
        store,
        owner,
        repo,
        repositoryId,
        shaByPath,
        batch,
        contents,
      );
      if (!ok) incomplete = true;
    }

    const finalWalk = selectContextFiles({
      changedPaths: changed,
      contents,
      allPaths,
      aliases,
      maxHops: config.max_hops,
      maxFiles: config.max_files,
    });

    const files = finalWalk.candidates.filter((c) => contents.has(c.path)).map((c) => ({
      path: c.path,
      content: contents.get(c.path)!,
      reasons: c.reasons,
      hops: c.hops,
    }));

    if (files.length === 0) return undefined;

    return {
      files,
      droppedPaths: finalWalk.dropped.map((c) => c.path),
      treeTruncated: tree.truncated,
      incomplete,
    };
  } catch (error) {
    // Context is an enhancement. Never let it fail the review.
    console.warn('⚠️ Review context unavailable, continuing with diff only:', (error as Error).message);
    return undefined;
  }
}

/**
 * Reads a batch of files, preferring the cache, and reports whether every
 * file's content ended up in the map.
 */
async function loadContents(
  ghService: GitHubService,
  store: RepositoryContextCache,
  owner: string,
  repo: string,
  repositoryId: string,
  shaByPath: Map<string, string>,
  paths: string[],
  into: Map<string, string>,
): Promise<boolean> {
  let ok = true;

  for (let i = 0; i < paths.length; i += BLOB_CONCURRENCY) {
    const slice = paths.slice(i, i + BLOB_CONCURRENCY);

    const results = await Promise.all(
      slice.map(async (path) => {
        const blobSha = shaByPath.get(path);
        if (!blobSha) return { path, content: null as string | null };

        // Cache first: a repeat review of the same repo pays no GitHub calls
        // for files it has already seen, which is what keeps this affordable.
        const cached = await store.get(repositoryId, blobSha).catch(() => null);
        if (cached) return { path, content: cached };

        const fetched = await ghService.getBlob(owner, repo, blobSha).catch(() => null);
        if (fetched !== null) {
          await store.put(repositoryId, blobSha, path, fetched).catch(() => undefined);
        }
        return { path, content: fetched };
      }),
    );

    for (const result of results) {
      if (result.content === null) ok = false;
      else into.set(result.path, result.content);
    }
  }

  return ok;
}

/**
 * Picks up path aliases so aliased imports still resolve to real files.
 * Without this, every `@/...` edge in a repo is silently lost.
 */
async function loadAliases(
  ghService: GitHubService,
  owner: string,
  repo: string,
  ref: string,
): Promise<PathAliases | null> {
  for (const path of TSCONFIG_PATHS) {
    try {
      const raw = await ghService.getFileContent(owner, repo, path, ref);
      if (!raw) continue;
      const aliases = parsePathAliases(JSON.parse(raw) as unknown, path);
      if (aliases) return aliases;
    } catch {
      // tsconfig may contain comments and is not always strict JSON. A repo
      // without usable aliases resolves fewer edges; that is not worth failing.
    }
  }
  return null;
}