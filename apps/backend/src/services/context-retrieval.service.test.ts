import { describe, it, expect } from 'vitest';

import { selectContextFiles, type NeighbourWalkInput } from './context-retrieval.service';
import { parsePathAliases } from './import-graph.service';

/**
 * A small payments-shaped repo, mirroring the motivating case: a PR changes
 * `payment.service.ts`, and the interesting context is the webhook that also
 * calls `createSubscription`, plus the repository layer below it.
 */
const WEBHOOK = `import { createSubscription } from '../services/payment.service';
export async function handleWebhook() { await createSubscription(); }`;

const PAYMENT = `import { saveSubscription } from '../repositories/subscription.repository';
export async function createSubscription() { await saveSubscription(); }`;

const REPOSITORY = `export async function saveSubscription() {}`;

const INDEX = `export * from './payment.service';
export * from './subscription.service';`;

const TESTS = `import { createSubscription } from './payment.service';
describe('payment', () => { it('creates', () => {}); });`;

function walk(overrides: Partial<NeighbourWalkInput> = {}) {
  const contents = new Map<string, string>([
    ['src/services/payment.service.ts', PAYMENT],
    ['src/repositories/subscription.repository.ts', REPOSITORY],
    ['src/legacy/index.ts', INDEX],
    ['src/services/payment.service.test.ts', TESTS],
  ]);

  return selectContextFiles({
    changedPaths: ['src/services/payment.service.ts'],
    contents,
    allPaths: [...contents.keys()],
    aliases: null,
    maxHops: 2,
    maxFiles: 25,
    ...overrides,
  });
}

describe('selectContextFiles()', () => {
  it('never includes a file the PR already changed', () => {
    const result = walk();
    expect(result.candidates.map((c) => c.path)).not.toContain('src/services/payment.service.ts');
  });

  it('finds the dependency the changed code imports', () => {
    const result = walk();
    expect(result.candidates.map((c) => c.path)).toContain('src/repositories/subscription.repository.ts');
  });

  it('finds an unrelated file that imports the changed one', () => {
    const contents = new Map<string, string>([
      ['src/services/payment.service.ts', PAYMENT],
      ['src/webhooks/stripe.webhook.ts', WEBHOOK],
      ['src/repositories/subscription.repository.ts', REPOSITORY],
    ]);

    const result = walk({
      changedPaths: ['src/services/payment.service.ts'],
      contents,
      allPaths: [...contents.keys()],
    });

    const paths = result.candidates.map((c) => c.path);
    // The webhook never appears in the diff, but it calls the changed function.
    expect(paths).toContain('src/webhooks/stripe.webhook.ts');
  });

  it('labels the two dependency directions distinctly', () => {
    const contents = new Map<string, string>([
      ['src/services/payment.service.ts', PAYMENT],
      ['src/webhooks/stripe.webhook.ts', WEBHOOK],
      ['src/repositories/subscription.repository.ts', REPOSITORY],
    ]);

    const result = walk({
      changedPaths: ['src/services/payment.service.ts'],
      contents,
      allPaths: [...contents.keys()],
    });

    // The webhook imports the changed file, so it is a caller of the change.
    const webhook = result.candidates.find((c) => c.path === 'src/webhooks/stripe.webhook.ts');
    // The repository is imported by the changed file, so it is a dependency.
    const repo = result.candidates.find((c) => c.path === 'src/repositories/subscription.repository.ts');

    expect(webhook?.reasons.join(' ')).toContain('imports changed file');
    expect(repo?.reasons.join(' ')).toContain('imported by changed file');
  });

  it('respects maxHops', () => {
    const contents = new Map<string, string>([
      ['src/a.ts', `import './b';`],
      ['src/b.ts', `import './c';`],
      ['src/c.ts', `import './d';`],
      ['src/d.ts', ``],
    ]);

    // `deep/one.ts` is included so the walk has something two hops away to
    // exclude; the assertion below is about b.ts being the only hop-1 neighbour.
    const result = walk({
      changedPaths: ['src/a.ts'],
      contents,
      allPaths: [...contents.keys()],
      maxHops: 1,
    });

    const paths = result.candidates.map((c) => c.path);
    expect(paths).toContain('src/b.ts');
    expect(paths).not.toContain('src/c.ts');
    expect(paths).not.toContain('src/d.ts');
  });

  it('caps at maxFiles and reports what it dropped', () => {
    const contents = new Map<string, string>([
      ['src/a.ts', `import './b'; import './c'; import './d';`],
      ['src/b.ts', ``],
      ['src/c.ts', ``],
      ['src/d.ts', ``],
    ]);

    const result = walk({
      changedPaths: ['src/a.ts'],
      contents,
      allPaths: [...contents.keys()],
      maxFiles: 2,
    });

    expect(result.candidates).toHaveLength(2);
    expect(result.dropped).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('keeps nearer files when the budget forces a choice', () => {
    const contents = new Map<string, string>([
      ['src/a.ts', `import './b'; import './deep/one'; import './deep/two';`],
      ['src/b.ts', ``],
      ['src/deep/one.ts', `import './two';`],
      ['src/deep/two.ts', ``],
    ]);

    const result = walk({
      changedPaths: ['src/a.ts'],
      contents,
      allPaths: [...contents.keys()],
      maxFiles: 1,
    });

    expect(result.candidates.map((c) => c.path)).toEqual(['src/b.ts']);
  });

  it('ranks a real implementation above a pure re-export barrel', () => {
    const contents = new Map<string, string>([
      ['src/a.ts', `import './hub'; import './real';`],
      // A barrel: imports and re-exports only, no logic to review.
      ['src/hub.ts', `export * from './b';\nexport * from './c';`],
      ['src/real.ts', `export function compute() { return 1; }`],
      ['src/b.ts', ``],
      ['src/c.ts', ``],
    ]);

    const result = walk({
      changedPaths: ['src/a.ts'],
      contents,
      allPaths: [...contents.keys()],
      maxFiles: 1,
    });

    expect(result.candidates[0].path).toBe('src/real.ts');
  });

  it('keeps a file that has both re-exports and real code', () => {
    const contents = new Map<string, string>([
      ['src/a.ts', `import './mixed'; import './real';`],
      ['src/mixed.ts', `export * from './b';\nexport function helper() { return 2; }`],
      ['src/real.ts', `export function compute() { return 1; }`],
      ['src/b.ts', ``],
    ]);

    const result = walk({
      changedPaths: ['src/a.ts'],
      contents,
      allPaths: [...contents.keys()],
      maxHops: 1,
      maxFiles: 2,
    });

    // mixed.ts holds real code, so it must not be demoted below real.ts on
    // the strength of its re-exports alone.
    const mixed = result.candidates.find((c) => c.path === 'src/mixed.ts');
    expect(mixed?.isBarrel).toBe(false);
  });

  it('prefers the less connected file when distance and reach tie', () => {
    const contents = new Map<string, string>([
      ['src/a.ts', `import './hub'; import './specific';`],
      // Hub: many files import it, so it is central but not specific.
      ['src/hub.ts', `export function shared() { return 0; }`],
      ['src/x.ts', `import './hub';`],
      ['src/y.ts', `import './hub';`],
      ['src/specific.ts', `export function only() { return 1; }`],
    ]);

    const result = walk({
      changedPaths: ['src/a.ts'],
      contents,
      allPaths: [...contents.keys()],
      maxFiles: 1,
    });

    // Both are one hop from the change; hub has higher in-degree, so the
    // tiebreak should prefer the specific file.
    expect(result.candidates[0].path).toBe('src/specific.ts');
  });

  it('prefers a file reached by several changed files', () => {
    const contents = new Map<string, string>([
      ['src/a.ts', `import './shared';`],
      ['src/b.ts', `import './shared';`],
      ['src/shared.ts', ``],
      ['src/one.ts', `import './only-one';`],
      ['src/only-one.ts', `import './a';`],
    ]);

    const result = walk({
      changedPaths: ['src/a.ts', 'src/b.ts'],
      contents,
      allPaths: [...contents.keys()],
      maxFiles: 1,
    });

    expect(result.candidates[0].path).toBe('src/shared.ts');
  });

  it('recognises a test file as covering context', () => {
    const result = walk();
    const test = result.candidates.find((c) => c.path === 'src/services/payment.service.test.ts');
    expect(test?.reasons.join(' ')).toContain('test file');
  });

  it('handles an import cycle without looping', () => {
    const contents = new Map<string, string>([
      ['src/a.ts', `import './b';`],
      ['src/b.ts', `import './a';`],
    ]);

    const result = walk({ changedPaths: ['src/a.ts'], contents, allPaths: [...contents.keys()] });
    expect(result.candidates.map((c) => c.path)).toEqual(['src/b.ts']);
  });

  it('ignores self-imports', () => {
    const contents = new Map<string, string>([['src/a.ts', `import './a';`]]);
    const result = walk({ changedPaths: ['src/a.ts'], contents, allPaths: ['src/a.ts'] });
    expect(result.candidates).toHaveLength(0);
  });

  it('resolves neighbours behind tsconfig aliases', () => {
    const aliases = parsePathAliases({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } });
    const contents = new Map<string, string>([
      ['src/index.ts', `import '@/repositories/subscription.repository';`],
      ['src/repositories/subscription.repository.ts', REPOSITORY],
    ]);

    const result = walk({
      changedPaths: ['src/index.ts'],
      contents,
      allPaths: [...contents.keys()],
      aliases,
    });

    expect(result.candidates.map((c) => c.path)).toContain(
      'src/repositories/subscription.repository.ts',
    );
  });

  it('returns nothing rather than failing when no content is available', () => {
    const result = walk({ contents: new Map(), allPaths: ['src/a.ts', 'src/b.ts'] });
    expect(result.candidates).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });

  it('does not throw on unparseable content', () => {
    const contents = new Map<string, string>([
      ['src/a.ts', `import { x from './b'; const s = "unterminated`],
      ['src/b.ts', `/* unterminated`],
    ]);

    expect(() => walk({ changedPaths: ['src/a.ts'], contents, allPaths: [...contents.keys()] })).not.toThrow();
  });

  it('treats a changed path outside the repo as absent', () => {
    const result = walk({ changedPaths: ['src/deleted.ts'], allPaths: ['src/other.ts'] });
    expect(result.candidates).toHaveLength(0);
  });

  it('reports a bare file with no edges as nothing', () => {
    const contents = new Map<string, string>([['src/lonely.ts', ``]]);
    const result = walk({ changedPaths: ['src/lonely.ts'], contents, allPaths: ['src/lonely.ts'] });
    expect(result.candidates).toHaveLength(0);
  });
});