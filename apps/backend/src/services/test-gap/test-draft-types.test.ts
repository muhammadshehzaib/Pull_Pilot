import { describe, it, expect } from 'vitest';
import { normalizeTestDraft, isInsufficient } from './test-draft-types';

describe('normalizeTestDraft', () => {
  it('normalizes the canonical shape', () => {
    const result = normalizeTestDraft({
      targetPath: 'tests/a.test.ts',
      content: 'it("x", () => {})',
      framework: 'vitest',
      notes: 'keep it small',
    });

    expect(isInsufficient(result)).toBe(false);
    if (!isInsufficient(result)) {
      expect(result.targetPath).toBe('tests/a.test.ts');
      expect(result.content).toBe('it("x", () => {})');
      expect(result.framework).toBe('vitest');
      expect(result.notes).toBe('keep it small');
    }
  });

  it('accepts field synonyms', () => {
    const result = normalizeTestDraft({ path: 'tests/b.test.ts', code: 'expect(1).toBe(1)' });
    expect(isInsufficient(result)).toBe(false);
    if (!isInsufficient(result)) {
      expect(result.targetPath).toBe('tests/b.test.ts');
      expect(result.content).toBe('expect(1).toBe(1)');
    }
  });

  it('unwraps a nested draft object', () => {
    const result = normalizeTestDraft({
      draft: { targetPath: 'tests/c.test.ts', content: 'body', framework: 'jest' },
    });
    expect(isInsufficient(result)).toBe(false);
    if (!isInsufficient(result)) {
      expect(result.targetPath).toBe('tests/c.test.ts');
      expect(result.content).toBe('body');
      expect(result.framework).toBe('jest');
    }
  });

  it('reports insufficiency when the model says so, with the reason', () => {
    const result = normalizeTestDraft({ insufficientContext: true, reason: 'no fixture found' });
    expect(isInsufficient(result)).toBe(true);
    if (isInsufficient(result)) expect(result.reason).toBe('no fixture found');
  });

  it('reports insufficiency when content is missing rather than inventing one', () => {
    const result = normalizeTestDraft({ targetPath: 'tests/a.test.ts' });
    expect(isInsufficient(result)).toBe(true);
  });

  it('reports insufficiency for unusable payloads', () => {
    expect(isInsufficient(normalizeTestDraft(null))).toBe(true);
    expect(isInsufficient(normalizeTestDraft('nope'))).toBe(true);
    expect(isInsufficient(normalizeTestDraft([]))).toBe(true);
  });
});
