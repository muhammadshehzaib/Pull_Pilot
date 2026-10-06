import { describe, expect, it, vi } from 'vitest';
import { buildReviewContext, type BuildReviewContextInput } from './context-builder';
import type { ContextConfig } from './config.service';
import type { GitHubService } from './github.service';
import type { RepositoryContextCache } from './repository-context-cache.service';

const TREE = [
  { path: 'src/a.ts', blobSha: 'sha:a', size: 10, mode: '100644' },
  { path: 'src/b.ts', blobSha: 'sha:b', size: 10, mode: '100644' },
  { path: 'src/c.ts', blobSha: 'sha:c', size: 10, mode: '100644' },
  { path: 'src/style.css', blobSha: 'sha:css', size: 10, mode: '100644' },
];

const SHA_TO_PATH = new Map(TREE.map((f) => [f.blobSha, f.path]));

const CONTENTS: Record<string, string> = {
  'src/a.ts': "import { b } from './b';\nexport const a = b;\n",
  'src/b.ts': "import { c } from './c';\nexport const b = c;\n",
  'src/c.ts': 'export const c = 1;\n',
  'src/style.css': 'body { color: red; }',
  'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['src/*'] } } }),
};

const config = (over: Partial<ContextConfig> = {}): ContextConfig => ({
  enabled: true,
  max_files: 25,
  max_hops: 2,
  max_tokens: 30_000,
  ...over,
});

/** Captures every blob SHA read so tests can assert on cost, not just output. */
function makeGh(over: Partial<Record<'getTree' | 'getBlob' | 'getFileContent', unknown>> = {}) {
  const gh = {
    getTree: vi.fn(async () => ({ files: TREE, truncated: false })),
    getBlob: vi.fn(async (_o: string, _r: string, blobSha: string) => {
      const path = SHA_TO_PATH.get(blobSha);
      return path ? CONTENTS[path] : null;
    }),
    getFileContent: vi.fn(async (_o: string, _r: string, path: string) => CONTENTS[path] ?? null),
    ...over,
  };
  return gh as unknown as GitHubService & typeof gh;
}

/** Map-backed stand-in for the encrypted cache, so tests stay DB-free. */
function makeCache() {
  const rows = new Map<string, string>();
  const cache = {
    rows,
    get: vi.fn(async (_repoId: string, blobSha: string) => rows.get(blobSha) ?? null),
    put: vi.fn(async (_repoId: string, blobSha: string, _path: string, content: string) => {
      rows.set(blobSha, content);
    }),
  };
  return cache as unknown as RepositoryContextCache & typeof cache;
}

function makeInput(over: Partial<BuildReviewContextInput> = {}): BuildReviewContextInput {
  return {
    ghService: makeGh(),
    owner: 'acme',
    repo: 'widget',
    repositoryId: 'repo-1',
    headSha: 'deadbeef',
    changedPaths: ['src/a.ts'],
    config: config(),
    cache: makeCache(),
    ...over,
  };
}

describe('buildReviewContext', () => {
  it('skips the tree request entirely when context is disabled', async () => {
    const gh = makeGh();
    const context = await buildReviewContext(makeInput({ ghService: gh, config: config({ enabled: false }) }));

    expect(context).toBeUndefined();
    expect(gh.getTree).not.toHaveBeenCalled();
  });

  it('skips when nothing changed', async () => {
    const gh = makeGh();
    const context = await buildReviewContext(makeInput({ ghService: gh, changedPaths: [] }));

    expect(context).toBeUndefined();
    expect(gh.getTree).not.toHaveBeenCalled();
  });

  it('returns undefined when the tree cannot be listed', async () => {
    const gh = makeGh({ getTree: vi.fn(async () => null) });
    await expect(buildReviewContext(makeInput({ ghService: gh }))).resolves.toBeUndefined();
  });

  it('returns undefined when no changed file is in the tree', async () => {
    const context = await buildReviewContext(makeInput({ changedPaths: ['src/missing.ts'] }));
    expect(context).toBeUndefined();
  });

  it('never throws when the API fails', async () => {
    const gh = makeGh({ getTree: vi.fn(async () => { throw new Error('boom'); }) });
    await expect(buildReviewContext(makeInput({ ghService: gh }))).resolves.toBeUndefined();
  });

  it('walks two hops out and excludes the changed file itself', async () => {
    const context = await buildReviewContext(makeInput({ config: config({ max_hops: 2 }) }));

    expect(context).toBeDefined();
    expect(context!.files.map((f) => f.path).sort()).toEqual(['src/b.ts', 'src/c.ts']);
    // b is one hop away, c two. The diff already carries a.ts, so it must not
    // be duplicated into the context block.
    expect(context!.files.find((f) => f.path === 'src/b.ts')!.hops).toBe(1);
    expect(context!.files.find((f) => f.path === 'src/c.ts')!.hops).toBe(2);
  });

  it('stops after one hop when max_hops is 1', async () => {
    const context = await buildReviewContext(makeInput({ config: config({ max_hops: 1 }) }));

    expect(context!.files.map((f) => f.path)).toEqual(['src/b.ts']);
  });

  it('never reads a file past the file budget', async () => {
    const gh = makeGh();
    const context = await buildReviewContext(makeInput({ ghService: gh, config: config({ max_files: 1 }) }));

    const read = gh.getBlob.mock.calls.map((c) => c[2]);
    expect(read).toContain('sha:a');
    expect(read).toContain('sha:b');
    // c is a legitimate neighbour but sits outside the budget, so it is never paid for.
    expect(read).not.toContain('sha:c');
    expect(context!.files.map((f) => f.path)).toEqual(['src/b.ts']);
  });

  it('does not refetch blobs already in the cache', async () => {
    const gh = makeGh();
    const cache = makeCache();

    await buildReviewContext(makeInput({ ghService: gh, cache }));
    expect(gh.getBlob).toHaveBeenCalled();
    const firstPass = gh.getBlob.mock.calls.length;

    // Same repository, same blobs: the cache should satisfy every read.
    const gh2 = makeGh();
    await buildReviewContext(makeInput({ ghService: gh2, cache }));
    expect(gh2.getBlob).not.toHaveBeenCalled();
    expect(firstPass).toBeGreaterThan(0);
  });

  it('reports incomplete context when a blob cannot be read', async () => {
    const gh = makeGh({
      getBlob: vi.fn(async (_o: string, _r: string, blobSha: string) =>
        blobSha === 'sha:c' ? null : CONTENTS[SHA_TO_PATH.get(blobSha)!] ?? null),
    });

    const context = await buildReviewContext(makeInput({ ghService: gh }));

    expect(context!.incomplete).toBe(true);
    expect(context!.files.map((f) => f.path)).toEqual(['src/b.ts']);
  });

  it('surfaces a truncated tree so the model is not told the map is complete', async () => {
    const gh = makeGh({ getTree: vi.fn(async () => ({ files: TREE, truncated: true })) });
    const context = await buildReviewContext(makeInput({ ghService: gh }));

    expect(context!.treeTruncated).toBe(true);
  });

  it('ignores non-source files even when they are in the tree', async () => {
    const gh = makeGh();
    const context = await buildReviewContext(makeInput({ ghService: gh }));

    expect(context!.files.map((f) => f.path)).not.toContain('src/style.css');
    expect(gh.getBlob.mock.calls.map((c) => c[2])).not.toContain('sha:css');
  });

  it('resolves aliased imports using the tsconfig paths', async () => {
    const aliased: Record<string, string> = {
      ...CONTENTS,
      'src/a.ts': "import { b } from '@/b';\nexport const a = b;\n",
    };
    const gh = {
      getTree: vi.fn(async () => ({ files: TREE, truncated: false })),
      getBlob: vi.fn(async (_o: string, _r: string, blobSha: string) => {
        const path = SHA_TO_PATH.get(blobSha);
        return path ? aliased[path] : null;
      }),
      getFileContent: vi.fn(async (_o: string, _r: string, path: string) => aliased[path] ?? null),
    } as unknown as GitHubService;

    const context = await buildReviewContext(makeInput({ ghService: gh }));

    expect(context!.files.map((f) => f.path)).toContain('src/b.ts');
  });

  it('returns undefined when nothing neighbour-worthy exists', async () => {
    const lone = [{ path: 'src/solo.ts', blobSha: 'sha:solo', size: 10, mode: '100644' }];
    const gh = {
      getTree: vi.fn(async () => ({ files: lone, truncated: false })),
      getBlob: vi.fn(async () => 'export const solo = 1;'),
      getFileContent: vi.fn(async () => null),
    } as unknown as GitHubService;

    await expect(buildReviewContext(makeInput({ ghService: gh }))).resolves.toBeUndefined();
  });
});
