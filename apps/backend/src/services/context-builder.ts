import picomatch from 'picomatch';
import type { GitHubService } from './github.service';
import { RepositoryContextCache } from './repository-context-cache.service';
import { selectContextFiles } from './context-retrieval.service';
import { buildFileIndex, parsePathAliases, resolveImportSpecifier, type PathAliases } from './import-graph.service';
import { buildImportIndex, RepositoryImportCache, type ImportCache, type IndexLimits } from './repository-import-index.service';
import { withContextSignal, type ContextDiscovery, type DiscoveryReason } from './context-discovery-types';
import type { ContextConfig } from './config.service';
import type { ReviewContext } from './ai/context-prompt';
import { CONTEXT_MAX_FILE_BYTES, CONTEXT_SOURCE_EXTENSIONS } from '../utils/constants';

const TSCONFIG_PATHS = ['tsconfig.json', 'packages/tsconfig.json'];

export interface BuildReviewContextInput {
  ghService: GitHubService;
  owner: string;
  repo: string;
  repositoryId: string;
  headSha: string;
  changedPaths: string[];
  config: ContextConfig;
  ignore?: string[];
  signal?: AbortSignal;
  cache?: Pick<RepositoryContextCache, 'get' | 'put'>;
  importCache?: ImportCache;
  indexLimits?: Partial<IndexLimits>;
}

/** Discover relationships first; source bodies are not a prerequisite for selection. */
export async function buildReviewContext(input: BuildReviewContextInput): Promise<ReviewContext | undefined> {
  const { ghService, owner, repo, repositoryId, headSha, config } = input;
  if (!config.enabled || !input.changedPaths.length) return undefined;
  const start = Date.now();
  input.signal?.throwIfAborted();
  const store = input.cache ?? new RepositoryContextCache();
  const ignored = picomatch(input.ignore ?? [], { dot: true });
  const reasons = new Set<DiscoveryReason>();
  let discovery: ContextDiscovery = { version: 1, status: 'UNAVAILABLE', headSha,
    eligibleFiles: 0, indexedFiles: 0, missingFiles: 0, selectedFiles: 0,
    importCacheHits: 0, sourceCacheHits: 0, downloads: 0, downloadedBytes: 0, elapsedMs: 0, reasons: [] };
  let treeTruncated = false;
  const ioSignal = () => input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
  const finish = (files: ReviewContext['files'], droppedPaths: string[] = []): ReviewContext => {
    discovery.selectedFiles = files.length;
    discovery.elapsedMs = Date.now() - start;
    discovery.reasons = [...new Set([...discovery.reasons, ...reasons])];
    if (discovery.status !== 'UNAVAILABLE' && discovery.reasons.length) discovery.status = 'PARTIAL';
    return { files, droppedPaths, treeTruncated, incomplete: discovery.status !== 'COMPLETE', discovery };
  };
  try {
    const treeSignal = ioSignal();
    const tree = await withContextSignal(ghService.getTree(owner, repo, headSha, treeSignal), treeSignal);
    if (!tree) { reasons.add('TREE_UNAVAILABLE'); return finish([]); }
    treeTruncated = tree.truncated;
    if (tree.truncated) reasons.add('TREE_TRUNCATED');
    const files = tree.files.filter(file => !ignored(file.path)
      && file.mode !== '120000' && file.mode !== '160000'
      && RepositoryContextCache.isContextCandidate(file.path, file.size));
    const byPath = new Map(files.map(file => [file.path, file]));
    const changed = input.changedPaths.filter(path => byPath.has(path));
    const supportedChange = (path: string) => CONTEXT_SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf('.')).toLowerCase());
    if (input.changedPaths.some(path => supportedChange(path) && !ignored(path) && !byPath.has(path))) reasons.add('MISSING_CHANGED_FILE');
    if (!changed.length) { discovery.eligibleFiles = files.length; discovery.missingFiles = files.length; return finish([]); }

    let aliases: PathAliases | null = null;
    const aliasSignal = ioSignal();
    for (const path of TSCONFIG_PATHS.filter(path => !ignored(path))) {
      input.signal?.throwIfAborted();
      try {
        const raw = await withContextSignal(ghService.getFileContent(owner, repo, path, headSha, aliasSignal), aliasSignal);
        if (raw === null) continue;
        const parsed = JSON.parse(raw);
        if (parsed.extends || parsed.references || parsed.compilerOptions?.baseUrl && !parsed.compilerOptions?.paths) reasons.add('UNSUPPORTED_RESOLUTION');
        if (parsed.compilerOptions?.paths && Object.keys(parsed.compilerOptions.paths).some(key => key.includes('*') && !key.endsWith('/*'))) reasons.add('UNSUPPORTED_RESOLUTION');
        aliases = parsePathAliases(parsed, path);
        if (aliases) break;
      } catch { reasons.add('UNSUPPORTED_RESOLUTION'); }
    }
    if (tree.files.some(file => /(^|\/)tsconfig[^/]*\.json$/.test(file.path)
      && !TSCONFIG_PATHS.includes(file.path) && !ignored(file.path)
      && !file.path.split('/').some(part => ['node_modules', 'dist', 'vendor'].includes(part)))) reasons.add('UNSUPPORTED_RESOLUTION');

    const index = await buildImportIndex({ ghService, owner, repo, repositoryId, headSha,
      files, changedPaths: changed, sourceCache: store, importCache: input.importCache ?? new RepositoryImportCache(),
      signal: input.signal, limits: input.indexLimits });
    discovery = index.coverage;
    // Ignored targets do not contribute edges, but are not resolution failures.
    const resolutionPaths = buildFileIndex(tree.files.filter(file => RepositoryContextCache.isContextCandidate(file.path, 0)).map(file => file.path));
    for (const [path, entry] of index.imports) for (const specifier of entry.specifiers) {
      const ext = specifier.slice(specifier.lastIndexOf('.'));
      if ((specifier.startsWith('.') && (!/\.[^/]+$/.test(specifier) || CONTEXT_SOURCE_EXTENSIONS.has(ext))) || specifier.startsWith('@/')) {
        if (!resolveImportSpecifier(specifier, path, resolutionPaths, aliases)) reasons.add('UNRESOLVED_IMPORT');
      }
    }
    const walk = selectContextFiles({ changedPaths: changed, contents: index.contents,
      indexedImports: index.imports, allPaths: files.map(file => file.path), aliases,
      maxHops: config.max_hops, maxFiles: config.max_files });
    const selected: ReviewContext['files'] = [];
    const contentSignal = ioSignal();
    for (let i = 0; i < walk.candidates.length; i += 4) {
      input.signal?.throwIfAborted();
      if (contentSignal.aborted) { reasons.add('CONTENT_UNAVAILABLE'); break; }
      const batch = await Promise.all(walk.candidates.slice(i, i + 4).map(async candidate => {
        const file = byPath.get(candidate.path)!;
        let content = index.contents.get(file.path) ?? null;
        try {
          if (content === null) content = await withContextSignal(store.get(repositoryId, file.blobSha), contentSignal);
          if (content === null && !contentSignal.aborted) {
            content = await withContextSignal(ghService.getBlob(owner, repo, file.blobSha, contentSignal, CONTEXT_MAX_FILE_BYTES), contentSignal);
            if (content !== null && !contentSignal.aborted) await withContextSignal(store.put(repositoryId, file.blobSha, file.path, content), contentSignal).catch(() => {});
          }
        } catch { reasons.add('CONTENT_UNAVAILABLE'); }
        if (content === null || Buffer.byteLength(content, 'utf8') > CONTEXT_MAX_FILE_BYTES) {
          reasons.add('CONTENT_UNAVAILABLE'); return null;
        }
        return { path: file.path, content, reasons: candidate.reasons, hops: candidate.hops };
      }));
      selected.push(...batch.filter((file): file is NonNullable<typeof file> => file !== null));
    }
    input.signal?.throwIfAborted();
    return finish(selected, walk.dropped.map(file => file.path));
  } catch {
    input.signal?.throwIfAborted();
    reasons.add('TREE_UNAVAILABLE');
    return finish([]);
  }
}
