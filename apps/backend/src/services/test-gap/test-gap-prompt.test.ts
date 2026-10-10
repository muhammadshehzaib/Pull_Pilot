import { describe, it, expect } from 'vitest';
import { buildTestGapPrompt, TEST_GAP_SYSTEM_PROMPT } from './test-gap-prompt';
import type { TestGapInput } from './test-gap-types';

function input(overrides: Partial<TestGapInput> = {}): TestGapInput {
  return {
    changedSources: ['src/a.ts'],
    changedTests: [],
    relatedTests: [],
    sourceExcerpts: [],
    relatedTestExcerpts: [],
    treeTruncated: false,
    incomplete: false,
    ...overrides,
  };
}

describe('test-gap prompt', () => {
  it('requires strict JSON and constrains paths to the changed sources', () => {
    expect(TEST_GAP_SYSTEM_PROMPT).toContain('STRICT, RAW JSON');
    expect(TEST_GAP_SYSTEM_PROMPT).toContain('CHANGED SOURCE FILES');
    expect(TEST_GAP_SYSTEM_PROMPT).toContain('at most 8 scenarios');
  });

  it('lists sources, changed tests, and related tests', () => {
    const prompt = buildTestGapPrompt(
      input({
        changedSources: ['src/a.ts', 'src/b.ts'],
        changedTests: ['src/a.test.ts'],
        relatedTests: ['src/legacy/a.spec.ts'],
      }),
    );

    expect(prompt).toContain('CHANGED SOURCE FILES:');
    expect(prompt).toContain('- src/a.ts');
    expect(prompt).toContain('TEST FILES ALREADY CHANGED');
    expect(prompt).toContain('- src/a.test.ts');
    expect(prompt).toContain('EXISTING RELATED TESTS');
    expect(prompt).toContain('- src/legacy/a.spec.ts');
  });

  it('includes the source and test excerpts', () => {
    const prompt = buildTestGapPrompt(
      input({
        sourceExcerpts: [{ path: 'src/a.ts', content: 'export const a = 1;' }],
        relatedTestExcerpts: [{ path: 'src/a.test.ts', content: 'test("a", () => {});' }],
      }),
    );
    expect(prompt).toContain('--- CHANGED SOURCE: src/a.ts ---');
    expect(prompt).toContain('export const a = 1;');
    expect(prompt).toContain('--- EXISTING TEST: src/a.test.ts ---');
  });

  it('warns when the view is incomplete', () => {
    expect(buildTestGapPrompt(input({ incomplete: true }))).toContain('only partially available');
    expect(buildTestGapPrompt(input({ treeTruncated: true }))).toContain('only partially available');
    expect(buildTestGapPrompt(input())).not.toContain('only partially available');
  });
});
