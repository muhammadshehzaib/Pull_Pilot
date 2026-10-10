import { describe, expect, it } from 'vitest';
import { canCreateTestPr, validateProposedTestPath } from './testDraft';

describe('test draft path validation', () => {
  it('accepts test source files in test directories and conventional names', () => {
    expect(validateProposedTestPath('tests/payment.ts').ok).toBe(true);
    expect(validateProposedTestPath('src/payment.test.ts').ok).toBe(true);
  });

  it('rejects non-source files even when placed under a test directory', () => {
    expect(validateProposedTestPath('tests/package.json').ok).toBe(false);
    expect(validateProposedTestPath('tests/install.sh').ok).toBe(false);
  });
});

describe('test PR confirmation', () => {
  it('only enables creation for a pending draft after explicit confirmation', () => {
    const draft = { status: 'DRAFT' } as any;
    expect(canCreateTestPr(draft, false)).toBe(false);
    expect(canCreateTestPr(draft, true)).toBe(true);
    expect(canCreateTestPr({ status: 'PR_CREATED' } as any, true)).toBe(false);
  });
});
