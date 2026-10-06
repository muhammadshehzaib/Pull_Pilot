import { describe, it, expect } from 'vitest';

import {
  formatContextForPrompt,
  type ContextFile,
  type ReviewContext,
} from './context-prompt';

function file(path: string, content: string, reasons = ['imported by changed file']): ContextFile {
  return { path, content, reasons, hops: 1 };
}

function ctx(files: ContextFile[], overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    files,
    droppedPaths: [],
    treeTruncated: false,
    incomplete: false,
    ...overrides,
  };
}

describe('formatContextForPrompt()', () => {
  it('returns nothing for an absent context', () => {
    expect(formatContextForPrompt(undefined, 1000)).toBe('');
  });

  it('returns nothing for an empty file list', () => {
    expect(formatContextForPrompt(ctx([]), 1000)).toBe('');
  });

  it('returns nothing rather than a bare header when the budget is too small', () => {
    expect(formatContextForPrompt(ctx([file('a.ts', 'x')]), 10)).toBe('');
  });

  it('includes each selected file and why it was selected', () => {
    const out = formatContextForPrompt(
      ctx([
        file('src/payment.ts', 'export const a = 1;', ['imports changed file']),
        file('src/webhook.ts', 'export const b = 2;', ['imported by changed file']),
      ]),
      10_000,
    );

    expect(out).toContain('FILE: src/payment.ts');
    expect(out).toContain('FILE: src/webhook.ts');
    expect(out).toContain('imports changed file');
    expect(out).toContain('imported by changed file');
    expect(out).toContain('export const a = 1;');
  });

  it('brackets the block so the diff cannot be mistaken for context', () => {
    const out = formatContextForPrompt(ctx([file('a.ts', 'x')]), 10_000);

    expect(out).toContain('--- SURROUNDING REPOSITORY CONTEXT ---');
    expect(out).toContain('--- END SURROUNDING REPOSITORY CONTEXT ---');
    expect(out.indexOf('SURROUNDING')).toBeLessThan(out.indexOf('END SURROUNDING'));
  });

  it('tells the model to only report findings anchored to changed lines', () => {
    const out = formatContextForPrompt(ctx([file('a.ts', 'x')]), 10_000);

    expect(out).toMatch(/never report a finding whose line is in a context file/i);
    expect(out).toMatch(/background only/i);
    expect(out).toMatch(/do not assume the existence or behaviour of files/i);
  });

  it('asks the model to name the context file when it changes a conclusion', () => {
    const out = formatContextForPrompt(ctx([file('a.ts', 'x')]), 10_000);

    expect(out).toContain('also called from');
  });

  it('stays within the character budget', () => {
    const big = Array.from({ length: 40 }, (_, i) => file(`src/f${i}.ts`, 'x'.repeat(5000)));

    const out = formatContextForPrompt(ctx(big), 20_000);

    expect(out.length).toBeLessThanOrEqual(20_000);
    expect(out.length).toBeGreaterThan(0);
  });

  it('keeps the nearest files intact when the budget forces a cut', () => {
    const out = formatContextForPrompt(
      ctx([
        file('src/first.ts', 'FIRST_CONTENT_MARKER'),
        file('src/second.ts', 'y'.repeat(100_000)),
        file('src/third.ts', 'THIRD_CONTENT_MARKER'),
      ]),
      1_500,
    );

    // The first file always fits, so it is never the one that gets cut.
    expect(out).toContain('FIRST_CONTENT_MARKER');
  });

  it('marks a truncated file rather than silently dropping it', () => {
    const out = formatContextForPrompt(
      ctx([file('src/huge.ts', 'z'.repeat(500_000))]),
      2_000,
    );

    expect(out).toContain('src/huge.ts');
    expect(out).toContain('truncated to fit context budget');
  });

  it('reports when the repository tree listing itself was incomplete', () => {
    const out = formatContextForPrompt(
      ctx([file('a.ts', 'x')], { treeTruncated: true }),
      10_000,
    );

    expect(out).toMatch(/listing was incomplete/i);
  });

  it('reports when files could not be fetched', () => {
    const out = formatContextForPrompt(
      ctx([file('a.ts', 'x')], { incomplete: true }),
      10_000,
    );

    expect(out).toMatch(/could not be fetched/i);
  });

  it('lists dropped neighbours so the model knows context is partial', () => {
    const out = formatContextForPrompt(
      ctx([file('a.ts', 'x')], { droppedPaths: ['src/b.ts', 'src/c.ts', 'src/d.ts'] }),
      10_000,
    );

    expect(out).toContain('src/b.ts');
    expect(out).toContain('3 further file');
  });

  it('caps a very long dropped list instead of flooding the prompt', () => {
    const dropped = Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`);
    const out = formatContextForPrompt(ctx([file('a.ts', 'x')], { droppedPaths: dropped }), 10_000);

    expect(out).toContain('...');
    expect(out).not.toContain('src/f29.ts');
  });

  it('says context is a selection rather than pretending it is the whole repo', () => {
    const out = formatContextForPrompt(ctx([file('a.ts', 'x')]), 10_000);
    expect(out).toMatch(/bounded selection/i);
  });
});