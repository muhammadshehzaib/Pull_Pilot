import { describe, it, expect } from 'vitest';
import { detectTestFramework } from './framework-detect';

describe('detectTestFramework', () => {
  it('detects vitest from package.json', () => {
    expect(detectTestFramework({ packageJson: '{"devDependencies":{"vitest":"^2"}}' })).toBe('vitest');
  });

  it('detects jest from a related test import', () => {
    expect(
      detectTestFramework({
        relatedTestExcerpts: [{ path: 'a.test.ts', content: "import { jest } from '@jest/globals'" }],
      }),
    ).toBe('jest');
  });

  it('prefers vitest when both appear', () => {
    expect(
      detectTestFramework({
        packageJson: '{"devDependencies":{"jest":"^29","vitest":"^2"}}',
      }),
    ).toBe('vitest');
  });

  it('detects pytest from a filename convention', () => {
    expect(detectTestFramework({ relatedTestPaths: ['tests/test_service.py'] })).toBe('pytest');
  });

  it('detects go tests', () => {
    expect(detectTestFramework({ relatedTestPaths: ['pkg/service_test.go'] })).toBe('go test');
  });

  it('returns undefined when nothing is recognised', () => {
    expect(detectTestFramework({ relatedTestPaths: ['weird.test.xyz'] })).toBeUndefined();
    expect(detectTestFramework({})).toBeUndefined();
  });
});
