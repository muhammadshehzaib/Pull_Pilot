import prisma from '../config/prisma';
import { EncryptionService } from './encryption.service';
import { RepositoryContextCache } from './repository-context-cache.service';
import { inspectImports } from './import-graph.service';
import { isBarrelFile } from './context-retrieval.service';
import type { GitHubService, RepoTreeEntry } from './github.service';
import { CONTEXT_RETENTION_HOURS, CONTEXT_INDEX_MAX_FILES, CONTEXT_INDEX_MAX_DOWNLOADS,
  CONTEXT_INDEX_MAX_BYTES, CONTEXT_INDEX_TIMEOUT_MS, CONTEXT_INDEX_CONCURRENCY,
  CONTEXT_MAX_FILE_BYTES } from '../utils/constants';
import { withContextSignal, type ContextDiscovery, type DiscoveryReason } from './context-discovery-types';

export const IMPORT_PARSER_VERSION = 1;
export interface IndexedImports { specifiers: string[]; barrel: boolean; unsupported: boolean }
export interface ImportCache {
  getMany(repositoryId: string, shas: string[], signal: AbortSignal,
    onHit?: (sha: string, value: IndexedImports) => void): Promise<Map<string, IndexedImports>>;
  put(repositoryId: string, sha: string, value: IndexedImports): Promise<void>;
}

export class RepositoryImportCache implements ImportCache {
  constructor(private readonly retentionMs = CONTEXT_RETENTION_HOURS * 3_600_000) {}

  async getMany(repositoryId: string, shas: string[], signal: AbortSignal,
    onHit?: (sha: string, value: IndexedImports) => void): Promise<Map<string, IndexedImports>> {
    const result = new Map<string, IndexedImports>();
    const rows = await withContextSignal(prisma.cachedImport.findMany({
      where: { repositoryId, blobSha: { in: shas }, parserVersion: IMPORT_PARSER_VERSION,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      take: shas.length,
    }), signal);
    const order = new Map(shas.map((sha, index) => [sha, index]));
    rows.sort((a, b) => (order.get(a.blobSha) ?? 0) - (order.get(b.blobSha) ?? 0));
    for (const row of rows) {
      if (signal.aborted) break;
      try {
        const value = JSON.parse(await EncryptionService.decrypt(row.encryptedData, row.iv, row.authTag, row.salt));
        if (Array.isArray(value.specifiers) && value.specifiers.every((s: unknown) => typeof s === 'string')
          && typeof value.barrel === 'boolean' && typeof value.unsupported === 'boolean') {
          result.set(row.blobSha, value);
          onHit?.(row.blobSha, value);
        }
      } catch { /* Corrupt or rotated records are misses, never trusted edges. */ }
      // Encryption uses scrypt. Yield so deadlines/cancellation remain observable.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    return result;
  }

  async put(repositoryId: string, blobSha: string, value: IndexedImports): Promise<void> {
    const envelope = await EncryptionService.encrypt(JSON.stringify(value));
    const expiresAt = this.retentionMs > 0 ? new Date(Date.now() + this.retentionMs) : null;
    // A late operation after disconnect must not recreate derived source data.
    await prisma.$transaction(async tx => {
      const active = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "repositories" WHERE "id" = ${repositoryId} AND "isActive" = true FOR UPDATE`;
      if (!active.length) return;
      await tx.cachedImport.upsert({
        where: { repositoryId_blobSha_parserVersion: { repositoryId, blobSha, parserVersion: IMPORT_PARSER_VERSION } },
        create: { repositoryId, blobSha, parserVersion: IMPORT_PARSER_VERSION, ...envelope, expiresAt },
        update: { ...envelope, expiresAt },
      });
    });
  }
}

export interface IndexLimits { maxFiles: number; maxDownloads: number; maxBytes: number; timeoutMs: number; concurrency: number }
export const DEFAULT_INDEX_LIMITS: IndexLimits = { maxFiles: CONTEXT_INDEX_MAX_FILES,
  maxDownloads: CONTEXT_INDEX_MAX_DOWNLOADS, maxBytes: CONTEXT_INDEX_MAX_BYTES,
  timeoutMs: CONTEXT_INDEX_TIMEOUT_MS, concurrency: CONTEXT_INDEX_CONCURRENCY };

/** No resolved edges are persisted: paths and aliases belong to a commit, not a blob. */
export async function buildImportIndex(input: {
  ghService: GitHubService; owner: string; repo: string; repositoryId: string; headSha: string;
  files: RepoTreeEntry[]; changedPaths: string[]; sourceCache: Pick<RepositoryContextCache, 'get' | 'put'>;
  importCache: ImportCache; signal?: AbortSignal; limits?: Partial<IndexLimits>;
}) {
  const limits = { ...DEFAULT_INDEX_LIMITS, ...input.limits };
  const start = Date.now();
  const timer = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, timer.signal]) : timer.signal;
  const deadline = setTimeout(() => timer.abort(new Error('Context indexing deadline')), limits.timeoutMs);
  const reasons = new Set<DiscoveryReason>();
  const imports = new Map<string, IndexedImports>();
  const contents = new Map<string, string>();
  const coverage: ContextDiscovery = { version: 1, status: 'COMPLETE', headSha: input.headSha,
    eligibleFiles: input.files.length, indexedFiles: 0, missingFiles: 0, selectedFiles: 0,
    importCacheHits: 0, sourceCacheHits: 0, downloads: 0, downloadedBytes: 0, elapsedMs: 0, reasons: [] };
  // Nearby files first improves bounded cold discovery; subsequent reviews skip
  // cached work and use their download slots for previously missing blobs.
  const changed = new Set(input.changedPaths);
  const dirs = input.changedPaths.map(path => path.slice(0, path.lastIndexOf('/') + 1));
  const priority = (path: string) => changed.has(path) ? 0 : dirs.some(dir => path.startsWith(dir)) ? 1 : 2;
  const files = [...input.files].sort((a, b) => priority(a.path) - priority(b.path) || a.path.localeCompare(b.path)).slice(0, limits.maxFiles);
  if (files.length < input.files.length) reasons.add('FILE_LIMIT');
  try {
    let cached = new Map<string, IndexedImports>();
    try {
      const complete = await withContextSignal(input.importCache.getMany(input.repositoryId, [...new Set(files.map(f => f.blobSha))], signal,
        (sha, value) => { if (!signal.aborted) cached.set(sha, value); }), signal);
      for (const [sha, value] of complete) cached.set(sha, value);
    }
    catch { if (!signal.aborted) reasons.add('CACHE_UNAVAILABLE'); }
    const missing: RepoTreeEntry[] = [];
    for (const file of files) {
      const value = cached.get(file.blobSha);
      if (value) { imports.set(file.path, value); coverage.importCacheHits++; }
      else missing.push(file);
    }
    // Share work when two paths reference the same bytes.
    const pending = new Map<string, Promise<{ value: IndexedImports; content: string } | null>>();
    let reservedBytes = 0;
    const read = (file: RepoTreeEntry) => {
      let operation = pending.get(file.blobSha);
      if (operation) return operation;
      operation = (async () => {
        if (signal.aborted) return null;
        let content: string | null = null;
        try { content = await withContextSignal(input.sourceCache.get(input.repositoryId, file.blobSha), signal); }
        catch { if (!signal.aborted) reasons.add('CACHE_UNAVAILABLE'); }
        if (signal.aborted) return null;
        if (content !== null) coverage.sourceCacheHits++;
        else {
          if (coverage.downloads >= limits.maxDownloads) { reasons.add('DOWNLOAD_LIMIT'); return null; }
          // Reserve before await so concurrent reads cannot overspend the byte cap.
          const reservation = file.size || CONTEXT_MAX_FILE_BYTES;
          if (reservedBytes + reservation > limits.maxBytes) { reasons.add('BYTE_LIMIT'); return null; }
          reservedBytes += reservation;
          coverage.downloads++;
          try { content = await withContextSignal(input.ghService.getBlob(input.owner, input.repo, file.blobSha, signal, Math.min(CONTEXT_MAX_FILE_BYTES, reservation)), signal); }
          catch { if (!signal.aborted) reasons.add('FILE_UNAVAILABLE'); }
          if (signal.aborted) return null;
          if (content !== null) {
            const bytes = Buffer.byteLength(content, 'utf8');
            coverage.downloadedBytes += bytes;
            reservedBytes += bytes - reservation;
            if (coverage.downloadedBytes > limits.maxBytes) { reasons.add('BYTE_LIMIT'); return null; }
          }
        }
        if (content === null) { reasons.add('FILE_UNAVAILABLE'); return null; }
        if (Buffer.byteLength(content, 'utf8') > CONTEXT_MAX_FILE_BYTES) { reasons.add('OVERSIZED_FILE'); return null; }
        const value: IndexedImports = { ...inspectImports(content), barrel: isBarrelFile(content) };
        if (signal.aborted) return null;
        try { await withContextSignal(input.importCache.put(input.repositoryId, file.blobSha, value), signal); }
        catch { if (!signal.aborted) reasons.add('CACHE_UNAVAILABLE'); }
        if (signal.aborted) return { value, content };
        // Keep the existing encrypted source cache useful for selected contents.
        try { await withContextSignal(input.sourceCache.put(input.repositoryId, file.blobSha, file.path, content), signal); }
        catch { if (!signal.aborted) reasons.add('CACHE_UNAVAILABLE'); }
        return { value, content };
      })();
      pending.set(file.blobSha, operation);
      return operation;
    };
    for (let i = 0; i < missing.length && !signal.aborted; i += limits.concurrency) {
      const batch = missing.slice(i, i + limits.concurrency);
      await Promise.all(batch.map(async file => {
        const result = await read(file);
        if (result) { imports.set(file.path, result.value); contents.set(file.path, result.content); }
      }));
    }
  } finally {
    clearTimeout(deadline);
    input.signal?.throwIfAborted();
    if (timer.signal.aborted) reasons.add('DEADLINE');
  }
  if ([...imports.values()].some(value => value.unsupported)) reasons.add('UNSUPPORTED_RESOLUTION');
  coverage.indexedFiles = imports.size;
  coverage.missingFiles = coverage.eligibleFiles - imports.size;
  coverage.elapsedMs = Date.now() - start;
  coverage.reasons = [...reasons];
  coverage.status = coverage.missingFiles || reasons.size ? 'PARTIAL' : 'COMPLETE';
  return { imports, contents, coverage };
}
