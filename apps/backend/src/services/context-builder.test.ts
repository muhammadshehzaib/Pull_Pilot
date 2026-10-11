import { describe, expect, it, vi } from 'vitest';
import { buildReviewContext, type BuildReviewContextInput } from './context-builder';
import type { ContextConfig } from './config.service';
import type { GitHubService } from './github.service';
import type { RepositoryContextCache } from './repository-context-cache.service';
import type { IndexedImports } from './repository-import-index.service';
import { formatContextForPrompt } from './ai/context-prompt';

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
  const imports = new Map<string, IndexedImports>();
  return {
    ghService: makeGh(),
    owner: 'acme',
    repo: 'widget',
    repositoryId: 'repo-1',
    headSha: 'deadbeef',
    changedPaths: ['src/a.ts'],
    config: config(),
    cache: makeCache(),
    importCache: { getMany: async () => new Map(imports), put: async (_repo, sha, value) => { imports.set(sha, value); } },
    ...over,
  };
}

function sourceFixture(sources: Record<string, string>, changedPaths: string[]) {
  const gh = {
    getTree: vi.fn(async () => ({ files: Object.keys(sources).map(path => ({ path, blobSha: path, size: Buffer.byteLength(sources[path]), mode: '100644' })), truncated: false })),
    getBlob: vi.fn(async (_o: string, _r: string, sha: string) => sources[sha] ?? null),
    getFileContent: vi.fn(async () => null as string | null),
  };
  return { gh, input: makeInput({ ghService: gh as unknown as GitHubService, changedPaths }) };
}

describe('buildReviewContext', () => {
  it('keeps direct callers, tests and dependencies represented under a tight prompt budget', async () => {
    const f = sourceFixture({
      'src/payment.ts': "import './a'; import './b'; import './c';",
      'src/a.ts': '', 'src/b.ts': '', 'src/c.ts': '',
      'src/webhook.ts': "import './payment';",
      'src/payment.test.ts': "import './payment';",
    }, ['src/payment.ts']);
    const result = await buildReviewContext({ ...f.input, config: config({ max_files: 3 }) });
    expect(result?.files).toHaveLength(3);
    expect(result?.files.map(file => file.path)).toEqual(expect.arrayContaining(['src/webhook.ts', 'src/payment.test.ts']));
    expect(result?.files.some(file => ['src/a.ts', 'src/b.ts', 'src/c.ts'].includes(file.path))).toBe(true);
    expect(result?.droppedPaths).toHaveLength(2);
  });

  it('finds name-matched tests without imports, preferring the same monorepo package', async () => {
    const f = sourceFixture({ 'packages/pay/src/payment.ts': 'export const pay = 1;',
      'packages/pay/tests/payment.test.ts': 'describe("payment", () => {});',
      'packages/other/tests/payment.test.ts': 'describe("other", () => {});' }, ['packages/pay/src/payment.ts']);
    const result = await buildReviewContext(f.input);
    expect(result?.files.map(file => file.path)).toEqual(['packages/pay/tests/payment.test.ts']);
    expect(result?.files[0].reasons[0]).toMatch(/likely related test/);
  });

  it('applies ignore policy before fetching imports, selected files or root configuration', async () => {
    const f = sourceFixture({ 'src/payment.ts': 'export const pay = 1;',
      'src/private.ts': "import './payment';", 'src/webhook.ts': "import './payment';" }, ['src/payment.ts']);
    const result = await buildReviewContext({ ...f.input, ignore: ['src/private.ts', '**/tsconfig.json', 'tsconfig.json'] });
    expect(result?.files.map(file => file.path)).toEqual(['src/webhook.ts']);
    expect(f.gh.getBlob.mock.calls.map(call => call[2])).not.toContain('src/private.ts');
    expect(f.gh.getFileContent).not.toHaveBeenCalled();
  });

  it('reports partial indexing even when its selection is empty', async () => {
    const f = sourceFixture({ 'src/payment.ts': 'export const pay = 1;', 'src/webhook.ts': "import './payment';" }, ['src/payment.ts']);
    const result = await buildReviewContext({ ...f.input, indexLimits: { maxDownloads: 1 } });
    expect(result?.files).toEqual([]);
    expect(result?.discovery).toMatchObject({ status: 'PARTIAL', indexedFiles: 1, missingFiles: 1 });
    expect(result?.discovery?.reasons).toContain('DOWNLOAD_LIMIT');
  });

  it('re-resolves cached imports after renames and does not carry deleted targets into a new commit', async () => {
    const f = sourceFixture({ 'src/payment.ts': 'export const pay = 1;', 'src/webhook.ts': "import './payment';" }, ['src/payment.ts']);
    const first = await buildReviewContext(f.input);
    expect(first?.files.map(file => file.path)).toContain('src/webhook.ts');
    f.gh.getTree.mockResolvedValue({ files: [
      { path: 'src/payment.ts', blobSha: 'src/payment.ts', size: 25, mode: '100644' },
      { path: 'elsewhere/webhook.ts', blobSha: 'src/webhook.ts', size: 19, mode: '100644' },
    ], truncated: false });
    const moved = await buildReviewContext({ ...f.input, headSha: 'second-commit' });
    expect(moved?.files).toEqual([]);
    expect(moved?.discovery?.headSha).toBe('second-commit');
    expect(moved?.discovery?.reasons).toContain('UNRESOLVED_IMPORT');
    f.gh.getTree.mockResolvedValue({ files: [{ path: 'src/payment.ts', blobSha: 'src/payment.ts', size: 25, mode: '100644' }], truncated: false });
    expect((await buildReviewContext({ ...f.input, headSha: 'third-commit' }))?.files).toEqual([]);
  });

  it('re-resolves unchanged blobs when aliases change', async () => {
    const f = sourceFixture({ 'src/payment.ts': 'export const pay = 1;', 'other/payment.ts': '',
      'src/webhook.ts': "import '@/payment';" }, ['src/payment.ts']);
    f.gh.getFileContent.mockResolvedValue(JSON.stringify({ compilerOptions: { paths: { '@/*': ['src/*'] } } }));
    expect((await buildReviewContext(f.input))?.files.map(file => file.path)).toContain('src/webhook.ts');
    f.gh.getFileContent.mockResolvedValue(JSON.stringify({ compilerOptions: { paths: { '@/*': ['other/*'] } } }));
    expect((await buildReviewContext({ ...f.input, headSha: 'new-alias' }))?.files).toEqual([]);
  });
  it('keeps concurrent review graphs tied to their own commit inventories', async () => {
    const f = sourceFixture({ 'src/payment.ts': 'export const pay = 1;',
      'src/first.ts': "import './payment';", 'src/second.ts': "import './payment';" }, ['src/payment.ts']);
    const tree = await f.gh.getTree();
    f.gh.getTree.mockImplementation(async (...args: unknown[]) => ({ files: tree.files.filter(file =>
      file.path === 'src/payment.ts' || file.path === (args[2] === 'first' ? 'src/first.ts' : 'src/second.ts')), truncated: false }));
    const [first, second] = await Promise.all([
      buildReviewContext({ ...f.input, headSha: 'first' }), buildReviewContext({ ...f.input, headSha: 'second' }),
    ]);
    expect(first?.files.map(file => file.path)).toEqual(['src/first.ts']);
    expect(second?.files.map(file => file.path)).toEqual(['src/second.ts']);
  });

  it('does not fetch oversized files or symlinks', async () => {
    const f = sourceFixture({ 'src/payment.ts': '', 'src/link.ts': "import './payment';", 'src/huge.ts': "import './payment';" }, ['src/payment.ts']);
    const original = await f.gh.getTree();
    f.gh.getTree.mockResolvedValue({ ...original, files: original.files.map(file => ({ ...file,
      mode: file.path.endsWith('link.ts') ? '120000' : file.mode,
      size: file.path.endsWith('huge.ts') ? 10_000_000 : file.size })) });
    await buildReviewContext(f.input);
    expect(f.gh.getBlob.mock.calls.map(call => call[2])).toEqual(['src/payment.ts']);
  });

  it('discloses unsupported configurations and computed imports', async () => {
    const f = sourceFixture({ 'src/payment.ts': 'export const pay = 1;', 'src/webhook.ts': 'import(modulePath);' }, ['src/payment.ts']);
    f.gh.getFileContent.mockResolvedValue('{ // tsconfig with comments\n "extends": "base.json" }');
    const result = await buildReviewContext(f.input);
    expect(result?.discovery?.status).toBe('PARTIAL');
    expect(result?.discovery?.reasons).toContain('UNSUPPORTED_RESOLUTION');
  });

  it('stops before any requests when already cancelled', async () => {
    const f = sourceFixture({ 'src/payment.ts': '' }, ['src/payment.ts']);
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    await expect(buildReviewContext({ ...f.input, signal: controller.signal })).rejects.toThrow('cancelled');
    expect(f.gh.getTree).not.toHaveBeenCalled();
  });

  it('discovers unchanged importers and their tests from a cold cache even without outgoing imports', async () => {
    const sources: Record<string, string> = {
      'src/payment.service.ts': 'export const pay = () => 1;',
      'src/webhook.ts': "import { pay } from './payment.service'; pay();",
      'src/payment.service.test.ts': "import { pay } from './payment.service'; pay();",
      'src/webhook.test.ts': "import './webhook';",
      'src/unrelated.ts': 'export const other = 2;',
    };
    const gh = {
      getTree: vi.fn(async () => ({ files: Object.keys(sources).map(path => ({ path, blobSha: path, size: 80, mode: '100644' })), truncated: false })),
      getBlob: vi.fn(async (_o: string, _r: string, sha: string) => sources[sha] ?? null),
      getFileContent: vi.fn(async () => null),
    } as unknown as GitHubService;
    const context = await buildReviewContext(makeInput({ ghService: gh, changedPaths: ['src/payment.service.ts'] }));
    expect(context?.files.map(file => file.path)).toEqual(expect.arrayContaining([
      'src/webhook.ts', 'src/payment.service.test.ts', 'src/webhook.test.ts',
    ]));
    expect(context?.files.map(file => file.path)).not.toContain('src/unrelated.ts');
    const prompt = formatContextForPrompt(context, 12_000);
    expect(prompt).toContain('FILE: src/webhook.ts');
    expect(prompt).toContain("import { pay } from './payment.service'; pay();");
    expect(prompt).toContain('FILE: src/webhook.test.ts');
  });

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

  it('reports unavailable discovery when the tree cannot be listed', async () => {
    const gh = makeGh({ getTree: vi.fn(async () => null) });
    expect((await buildReviewContext(makeInput({ ghService: gh })))?.discovery?.status).toBe('UNAVAILABLE');
  });

  it('discloses missing/deleted changed files', async () => {
    const context = await buildReviewContext(makeInput({ changedPaths: ['src/missing.ts'] }));
    expect(context?.discovery?.reasons).toContain('MISSING_CHANGED_FILE');
  });

  it('never throws when the API fails', async () => {
    const gh = makeGh({ getTree: vi.fn(async () => { throw new Error('boom'); }) });
    expect((await buildReviewContext(makeInput({ ghService: gh })))?.discovery?.status).toBe('UNAVAILABLE');
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

  it('indexes beyond the prompt file budget while sending only selected files', async () => {
    const gh = makeGh();
    const context = await buildReviewContext(makeInput({ ghService: gh, config: config({ max_files: 1 }) }));

    const read = gh.getBlob.mock.calls.map((c) => c[2]);
    expect(read).toContain('sha:a');
    expect(read).toContain('sha:b');
    // Import discovery has a separate budget from prompt selection.
    expect(read).toContain('sha:c');
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

  it('preserves complete discovery metadata when there are no related files', async () => {
    const lone = [{ path: 'src/solo.ts', blobSha: 'sha:solo', size: 10, mode: '100644' }];
    const gh = {
      getTree: vi.fn(async () => ({ files: lone, truncated: false })),
      getBlob: vi.fn(async () => 'export const solo = 1;'),
      getFileContent: vi.fn(async () => null),
    } as unknown as GitHubService;

    const context = await buildReviewContext(makeInput({ ghService: gh, changedPaths: ['src/solo.ts'] }));
    expect(context?.files).toEqual([]);
    expect(context?.discovery?.status).toBe('COMPLETE');
  });
});
