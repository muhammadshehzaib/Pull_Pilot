import { beforeEach, describe, expect, it, vi } from 'vitest';
const database = vi.hoisted(() => {
  const cachedImport = { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() };
  const tx = { cachedImport, $queryRaw: vi.fn(async () => [{ id: 'repo' }]) };
  return { cachedImport, tx, $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)) };
});
vi.mock('../config/prisma', () => ({ default: database }));
import { buildImportIndex, RepositoryImportCache, IMPORT_PARSER_VERSION, type IndexedImports } from './repository-import-index.service';
import { EncryptionService } from './encryption.service';
import type { GitHubService } from './github.service';

function fixture() {
  const contents = new Map([['a', 'export const pay = 1;'], ['b', "import { pay } from './payment'; pay();"], ['c', '']]);
  const imports = new Map<string, IndexedImports>();
  const sources = new Map<string, string>();
  const getBlob = vi.fn(async (_owner: string, _repo: string, sha: string) => contents.get(sha) ?? null);
  return {
    imports, sources, getBlob,
    input: { ghService: { getBlob } as unknown as GitHubService, owner: 'acme', repo: 'demo', repositoryId: 'repo', headSha: 'head',
      files: ['payment.ts', 'webhook.ts', 'empty.ts'].map((path, i) => ({ path, blobSha: ['a', 'b', 'c'][i], size: 60, mode: '100644' })),
      changedPaths: ['payment.ts'],
      sourceCache: { get: vi.fn(async (_repo: string, sha: string) => sources.get(sha) ?? null),
        put: vi.fn(async (_repo: string, sha: string, _path: string, content: string) => { sources.set(sha, content); }) },
      importCache: { getMany: vi.fn(async () => new Map(imports)),
        put: vi.fn(async (_repo: string, sha: string, value: IndexedImports) => { imports.set(sha, value); }) },
    },
  };
}

describe('bounded import indexing', () => {
  it('caches empty import lists and avoids all warm indexing downloads', async () => {
    const f = fixture();
    const cold = await buildImportIndex(f.input);
    expect(cold.coverage).toMatchObject({ status: 'COMPLETE', indexedFiles: 3, downloads: 3 });
    expect(f.imports.get('c')?.specifiers).toEqual([]);
    f.getBlob.mockClear();
    const warm = await buildImportIndex(f.input);
    expect(warm.coverage).toMatchObject({ status: 'COMPLETE', downloads: 0, importCacheHits: 3 });
    expect(f.getBlob).not.toHaveBeenCalled();
  });

  it('uses download slots for previously missing files on subsequent reviews', async () => {
    const f = fixture();
    const first = await buildImportIndex({ ...f.input, limits: { maxDownloads: 1 } });
    expect(first.coverage).toMatchObject({ status: 'PARTIAL', downloads: 1, indexedFiles: 1, missingFiles: 2 });
    expect(first.coverage.reasons).toContain('DOWNLOAD_LIMIT');
    const next = await buildImportIndex({ ...f.input, limits: { maxDownloads: 1 } });
    expect(next.coverage).toMatchObject({ downloads: 1, indexedFiles: 2, importCacheHits: 1 });
  });

  it('respects inventory and concurrent byte reservations', async () => {
    const inventory = await buildImportIndex({ ...fixture().input, limits: { maxFiles: 1 } });
    expect(inventory.coverage).toMatchObject({ indexedFiles: 1, missingFiles: 2 });
    expect(inventory.coverage.reasons).toContain('FILE_LIMIT');
    const bytes = await buildImportIndex({ ...fixture().input, limits: { maxBytes: 60 } });
    expect(bytes.coverage.downloads).toBe(1);
    expect(bytes.coverage.reasons).toContain('BYTE_LIMIT');
  });

  it('reuses source-cache contents without spending network slots', async () => {
    const f = fixture();
    f.sources.set('a', '');
    const result = await buildImportIndex({ ...f.input, limits: { maxDownloads: 1 } });
    expect(result.coverage.sourceCacheHits).toBe(1);
    expect(result.imports.has('payment.ts')).toBe(true);
  });

  it('times out a hung download and does not start later batches', async () => {
    const f = fixture();
    f.getBlob.mockImplementation(() => new Promise(() => {}));
    const result = await buildImportIndex({ ...f.input, limits: { timeoutMs: 15, concurrency: 1 } });
    expect(result.coverage.status).toBe('PARTIAL');
    expect(result.coverage.reasons).toContain('DEADLINE');
    expect(f.getBlob).toHaveBeenCalledTimes(1);
    expect(f.getBlob.mock.calls[0][3]?.aborted).toBe(true);
  });
  it('preserves cache hits already decoded when the cache-read deadline expires', async () => {
    const f = fixture();
    const result = await buildImportIndex({ ...f.input, limits: { timeoutMs: 15 },
      importCache: { ...f.input.importCache, getMany: async (_repo, _shas, _signal, onHit) => {
        onHit?.('a', { specifiers: [], barrel: false, unsupported: false });
        return new Promise(() => {});
      } } });
    expect(result.coverage).toMatchObject({ status: 'PARTIAL', indexedFiles: 1, importCacheHits: 1 });
    expect(result.coverage.reasons).toContain('DEADLINE');
  });
  it('indexes a fixed 1000-file warm fixture with no blob downloads', async () => {
    const f = fixture();
    const files = Array.from({ length: 1000 }, (_, i) => ({ path: `src/${i}.ts`, blobSha: `sha-${i}`, size: 20, mode: '100644' }));
    for (const file of files) f.imports.set(file.blobSha, { specifiers: [], barrel: false, unsupported: false });
    const result = await buildImportIndex({ ...f.input, files, changedPaths: ['src/0.ts'] });
    expect(result.coverage).toMatchObject({ status: 'COMPLETE', indexedFiles: 1000, downloads: 0, importCacheHits: 1000 });
    expect(f.getBlob).not.toHaveBeenCalled();
  });

  it('propagates review cancellation instead of silently reporting partial success', async () => {
    const f = fixture();
    const controller = new AbortController();
    f.getBlob.mockImplementation(async () => { controller.abort(new Error('cancelled')); return ''; });
    await expect(buildImportIndex({ ...f.input, signal: controller.signal })).rejects.toThrow('cancelled');
    expect(f.input.importCache.put).not.toHaveBeenCalled();
  });

  it('does not cache unavailable files as successful empty imports', async () => {
    const f = fixture();
    f.getBlob.mockResolvedValue(null);
    const result = await buildImportIndex(f.input);
    expect(result.coverage).toMatchObject({ status: 'PARTIAL', indexedFiles: 0 });
    expect(f.input.importCache.put).not.toHaveBeenCalled();
  });

  it('keeps useful graph data if persistence fails', async () => {
    const f = fixture();
    f.input.importCache.put.mockRejectedValue(new Error('db offline'));
    const result = await buildImportIndex(f.input);
    expect(result.imports.size).toBe(3);
    expect(result.coverage.reasons).toContain('CACHE_UNAVAILABLE');
  });
});

describe('encrypted parsed-import cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENCRYPTION_KEY ||= 'context_cache_test_key_long_enough';
    database.cachedImport.findMany.mockResolvedValue([]);
    database.tx.$queryRaw.mockResolvedValue([{ id: 'repo' }]);
  });
  it('scopes reads by repository, parser version and unexpired records', async () => {
    await new RepositoryImportCache().getMany('tenant-A', ['sha'], new AbortController().signal);
    expect(database.cachedImport.findMany.mock.calls[0][0].where).toMatchObject({ repositoryId: 'tenant-A', parserVersion: IMPORT_PARSER_VERSION,
      blobSha: { in: ['sha'] }, OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }] });
  });
  it('encrypts extracted data and reads it back without persisting resolved paths', async () => {
    const value = { specifiers: ['./payment'], barrel: false, unsupported: false };
    const cache = new RepositoryImportCache(60_000);
    await cache.put('repo', 'sha', value);
    const row = database.cachedImport.upsert.mock.calls[0][0].create;
    expect(JSON.stringify(row)).not.toContain('./payment');
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(EncryptionService.decrypt(row.encryptedData, row.iv, row.authTag, row.salt)).toBe(JSON.stringify(value));
    database.cachedImport.findMany.mockResolvedValue([{ ...row, blobSha: 'sha' }]);
    expect((await cache.getMany('repo', ['sha'], new AbortController().signal)).get('sha')).toEqual(value);
  });
  it('honors indefinite retention and prevents late writes after disconnect', async () => {
    const cache = new RepositoryImportCache(0);
    const value = { specifiers: [], barrel: false, unsupported: false };
    await cache.put('repo', 'sha', value);
    expect(database.cachedImport.upsert.mock.calls[0][0].create.expiresAt).toBeNull();
    database.tx.$queryRaw.mockResolvedValue([]);
    database.cachedImport.upsert.mockClear();
    await cache.put('repo', 'sha', value);
    expect(database.cachedImport.upsert).not.toHaveBeenCalled();
  });
});
