import { describe, it, expect, vi } from 'vitest';
import { generateTestDraftForScenario } from './draft-generation.service';
import type { GitHubService } from '../github.service';
import type { TestGapScenario } from './test-gap-types';

const scenario: TestGapScenario = {
  filePath: 'src/a.ts',
  lineNumber: 3,
  scenario: 'handles empty input',
  expected: 'throws',
  confidence: 'HIGH',
};

function ghService(): GitHubService {
  return {
    getTree: async () => ({
      files: [{ path: 'src/a.ts' }, { path: 'tests/a.test.ts' }],
      truncated: false,
    }),
    getFileContent: async (_owner: string, _repo: string, path: string) => {
      if (path === 'package.json') return '{"devDependencies":{"vitest":"^1.0.0"}}';
      if (path === 'tests/a.test.ts') return `import { it } from 'vitest';`;
      return 'export const a = 1;';
    },
  } as unknown as GitHubService;
}

describe('generateTestDraftForScenario', () => {
  it('grounds the draft in discovery context and detects the framework', async () => {
    const generateTestDraft = vi.fn(async (input: any) => {
      expect(input.scenario.filePath).toBe('src/a.ts');
      expect(input.framework).toBe('vitest');
      expect(input.changedSources).toEqual(['src/a.ts']);
      expect(input.relatedTests).toEqual(['tests/a.test.ts']);
      return { targetPath: 'tests/a.test.ts', content: 'it("x", () => {})' };
    });

    const result = await generateTestDraftForScenario({
      ghService: ghService(),
      owner: 'o',
      repo: 'r',
      ref: 'sha',
      sourcePath: 'src/a.ts',
      scenario,
      provider: { generateTestDraft },
    });

    expect(generateTestDraft).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ targetPath: 'tests/a.test.ts' });
  });

  it('pins the scenario filePath to the requested source path', async () => {
    const generateTestDraft = vi.fn(async () => ({ targetPath: 'tests/a.test.ts', content: 'x' }));
    await generateTestDraftForScenario({
      ghService: ghService(),
      owner: 'o',
      repo: 'r',
      ref: 'sha',
      sourcePath: 'src/real.ts',
      scenario: { ...scenario, filePath: 'src/attacker.ts' },
      provider: { generateTestDraft },
    });

    const input = generateTestDraft.mock.calls[0][0] as any;
    expect(input.scenario.filePath).toBe('src/real.ts');
  });

  it('returns null when the path is not code under test', async () => {
    const generateTestDraft = vi.fn();
    const result = await generateTestDraftForScenario({
      ghService: ghService(),
      owner: 'o',
      repo: 'r',
      ref: 'sha',
      sourcePath: 'README.md',
      scenario,
      provider: { generateTestDraft },
    });

    expect(result).toBeNull();
    expect(generateTestDraft).not.toHaveBeenCalled();
  });

  it('throws a clear error when the provider cannot draft', async () => {
    await expect(
      generateTestDraftForScenario({
        ghService: ghService(),
        owner: 'o',
        repo: 'r',
        ref: 'sha',
        sourcePath: 'src/a.ts',
        scenario,
        provider: {},
      }),
    ).rejects.toThrow(/does not support test drafting/);
  });
});
