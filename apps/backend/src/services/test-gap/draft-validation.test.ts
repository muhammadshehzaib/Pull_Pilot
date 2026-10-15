import { describe, it, expect } from 'vitest';
import {
  validateProposedTestPath,
  validateDraftContent,
  checkDelimiterBalance,
} from './draft-validation';

describe('validateProposedTestPath', () => {
  it.each(['tests/conftest.py', 'tests/__init__.py', 'tests/setup.ts', 'tests/setupTests.js', 'tests/jest.config.js', 'tests/vitest.config.ts', 'tests/globalSetup.ts', '.github/workflows/foo.test.ts'])(
    'rejects shared setup and execution configuration: %s', path => {
      expect(validateProposedTestPath(path).ok).toBe(false);
    },
  );
  it('accepts a repo-relative test path and normalizes it', () => {
    const result = validateProposedTestPath('src/__tests__/foo.test.ts');
    expect(result).toEqual({ ok: true, path: 'src/__tests__/foo.test.ts' });
  });

  it('accepts conventional non-JS test filenames', () => {
    expect(validateProposedTestPath('pkg/test_foo.py').ok).toBe(true);
    expect(validateProposedTestPath('pkg/foo_test.go').ok).toBe(true);
    expect(validateProposedTestPath('FooTest.java').ok).toBe(true);
  });

  it('rejects absolute paths', () => {
    expect(validateProposedTestPath('/etc/foo.test.ts').ok).toBe(false);
  });

  it('rejects Windows drive letters and backslashes', () => {
    expect(validateProposedTestPath('C:\\repo\\foo.test.ts').ok).toBe(false);
    expect(validateProposedTestPath('src\\foo.test.ts').ok).toBe(false);
  });

  it('rejects traversal', () => {
    const result = validateProposedTestPath('../../foo.test.ts');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/\.\./);
  });

  it('rejects non-test files', () => {
    const result = validateProposedTestPath('src/index.ts');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/test file/i);
  });

  it('does not treat arbitrary files inside test directories as test code', () => {
    expect(validateProposedTestPath('tests/package.json').ok).toBe(false);
    expect(validateProposedTestPath('tests/install.sh').ok).toBe(false);
    expect(validateProposedTestPath('tests/payment.ts').ok).toBe(true);
  });

  it('rejects excluded directories', () => {
    expect(validateProposedTestPath('node_modules/foo.test.js').ok).toBe(false);
  });

  it('rejects control characters and non-strings', () => {
    expect(validateProposedTestPath('src/\u0000foo.test.ts').ok).toBe(false);
    expect(validateProposedTestPath(42).ok).toBe(false);
    expect(validateProposedTestPath('').ok).toBe(false);
  });
});

describe('validateDraftContent', () => {
  it('accepts plausible text', () => {
    const result = validateDraftContent('it("x", () => { expect(1).toBe(1); });');
    expect(result.ok).toBe(true);
    expect(result.note).toBeUndefined();
  });

  it('rejects empty and non-string content', () => {
    expect(validateDraftContent('   ').ok).toBe(false);
    expect(validateDraftContent(null).ok).toBe(false);
  });

  it('rejects NUL bytes (binary)', () => {
    expect(validateDraftContent('abc\u0000def').ok).toBe(false);
  });

  it('reports unbalanced delimiters as a non-blocking note', () => {
    const result = validateDraftContent('function foo() { return 1;');
    expect(result.ok).toBe(true);
    expect(result.note).toMatch(/heuristic/i);
  });
});

describe('checkDelimiterBalance', () => {
  it('ignores delimiters inside strings and comments', () => {
    expect(checkDelimiterBalance('const s = "({["; // {\n').balanced).toBe(true);
    expect(checkDelimiterBalance('const s = `a { b`;').balanced).toBe(true);
    expect(checkDelimiterBalance('/* { [ ( */ const x = [];').balanced).toBe(true);
  });

  it('flags a real imbalance', () => {
    expect(checkDelimiterBalance('if (a) { b(); ').balanced).toBe(false);
  });
});
