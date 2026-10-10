import { describe, it, expect, vi } from 'vitest';
import {
  collectTestGapInput,
  discoverRelatedTests,
  isSourcePath,
  isTestPath,
  matchesRelated,
  sourceStem,
} from './test-discovery.service';
import type { GitHubService } from '../github.service';

function gh(overrides: Partial<Record<keyof GitHubService, unknown>> = {}): GitHubService {
  return {
    getTree: vi.fn(async () => ({ files: [], truncated: false })),
    getFileContent: vi.fn(async () => null),
    ...overrides,
  } as unknown as GitHubService;
}

describe('test discovery — path classification', () => {
  it('recognises test files by convention and by directory', () => {
    expect(isTestPath('src/user/service.test.ts')).toBe(true);
    expect(isTestPath('src/user/service.spec.tsx')).toBe(true);
    expect(isTestPath('app/tests/test_user.py')).toBe(true);
    expect(isTestPath('pkg/store/user_test.go')).toBe(true);
    expect(isTestPath('spec/models/user_spec.rb')).toBe(true);
    expect(isTestPath('src/main/java/UserTest.java')).toBe(true);
    expect(isTestPath('__tests__/helper.js')).toBe(true);
    expect(isTestPath('src/user/service.ts')).toBe(false);
  });

  it('treats test files and build output as not-source', () => {
    expect(isSourcePath('src/user/service.ts')).toBe(true);
    expect(isSourcePath('src/user/service.test.ts')).toBe(false);
    expect(isSourcePath('node_modules/pkg/index.ts')).toBe(false);
    expect(isSourcePath('dist/bundle.js')).toBe(false);
    expect(isSourcePath('README.md')).toBe(false);
    expect(isSourcePath('logo.png')).toBe(false);
  });

  it('reduces source and test names to the same stem', () => {
    expect(sourceStem('src/user/service.ts')).toBe('service');
    expect(sourceStem('src/user/service.test.ts')).toBe('service');
    expect(sourceStem('tests/test_service.py')).toBe('service');
    expect(sourceStem('server/service_test.go')).toBe('service');
    expect(sourceStem('src/OrderTest.kt')).toBe('order');
    expect(matchesRelated('src/user/service.ts', 'src/user/service.test.ts')).toBe(true);
    expect(matchesRelated('src/user/service.ts', 'src/user/other.test.ts')).toBe(false);
  });
});

describe('discoverRelatedTests', () => {
  it('separates changed sources, changed tests, and related existing tests', () => {
    const all = [
      'src/user/service.ts',
      'src/user/service.test.ts',
      'src/user/other.test.ts',
      'src/user/service.ts',
    ];
    const result = discoverRelatedTests(all, [
      'src/user/service.ts',
      'src/user/session.test.ts',
    ]);

    expect(result.changedSources).toEqual(['src/user/service.ts']);
    expect(result.changedTests).toEqual(['src/user/session.test.ts']);
    expect(result.relatedTests).toEqual(['src/user/service.test.ts']);
  });

  it('excludes a changed file from the existing-test hints', () => {
    const result = discoverRelatedTests(
      ['src/a.ts', 'src/a.test.ts'],
      ['src/a.ts', 'src/a.test.ts'],
    );
    expect(result.relatedTests).toEqual([]);
  });
});

describe('collectTestGapInput', () => {
  it('returns null when the change contains no source files', async () => {
    const result = await collectTestGapInput({
      ghService: gh(),
      owner: 'o',
      repo: 'r',
      ref: 'sha',
      changedPaths: ['README.md', 'assets/logo.png'],
    });
    expect(result).toBeNull();
  });

  it('collects source and related-test excerpts, bounded', async () => {
    const contents: Record<string, string> = {
      'src/a.ts': 'export const a = 1;',
      'src/a.test.ts': 'test("a", () => {});',
    };
    const result = await collectTestGapInput({
      ghService: gh({
        getTree: vi.fn(async () => ({
          files: [{ path: 'src/a.ts' }, { path: 'src/a.test.ts' }, { path: 'src/b.ts' }],
          truncated: false,
        })),
        getFileContent: vi.fn(async (_o: string, _r: string, path: string) => contents[path] ?? null),
      }),
      owner: 'o',
      repo: 'r',
      ref: 'sha',
      changedPaths: ['src/a.ts'],
    });

    expect(result).not.toBeNull();
    expect(result!.changedSources).toEqual(['src/a.ts']);
    expect(result!.relatedTests).toEqual(['src/a.test.ts']);
    expect(result!.sourceExcerpts).toEqual([{ path: 'src/a.ts', content: 'export const a = 1;' }]);
    expect(result!.relatedTestExcerpts).toEqual([
      { path: 'src/a.test.ts', content: 'test("a", () => {});' },
    ]);
    expect(result!.incomplete).toBe(false);
  });

  it('still collects changed sources when the tree listing is unavailable', async () => {
    const result = await collectTestGapInput({
      ghService: gh({
        getTree: vi.fn(async () => null),
        getFileContent: vi.fn(async () => 'code'),
      }),
      owner: 'o',
      repo: 'r',
      ref: 'sha',
      changedPaths: ['src/a.ts'],
    });

    expect(result).not.toBeNull();
    expect(result!.changedSources).toEqual(['src/a.ts']);
    expect(result!.relatedTests).toEqual([]);
    // A missing listing means the view is partial and must say so.
    expect(result!.incomplete).toBe(true);
  });

  it('degrades safely when getTree throws', async () => {
    const result = await collectTestGapInput({
      ghService: gh({ getTree: vi.fn(async () => { throw new Error('no tree'); }) }),
      owner: 'o',
      repo: 'r',
      ref: 'sha',
      changedPaths: ['src/a.ts'],
    });
    expect(result).not.toBeNull();
    expect(result!.incomplete).toBe(true);
    expect(result!.changedSources).toEqual(['src/a.ts']);
  });
});
