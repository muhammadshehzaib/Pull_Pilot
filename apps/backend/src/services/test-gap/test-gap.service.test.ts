import { describe, it, expect, vi } from 'vitest';
import { runTestGapAnalysis } from './test-gap.service';
import { BaseAiProvider, type JsonCompletionRequest } from '../ai/providers/base.provider';
import type { GitHubService } from '../github.service';
import type { TestGapInput } from './test-gap-types';

function ghService(overrides: Partial<Record<string, unknown>> = {}): GitHubService {
  return {
    getTree: async () => ({ files: [{ path: 'src/a.ts' }], truncated: false }),
    getFileContent: async () => 'export const a = 1;',
    ...overrides,
  } as unknown as GitHubService;
}

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    ghService: ghService(),
    owner: 'o',
    repo: 'r',
    ref: 'sha',
    changedPaths: ['src/a.ts'],
    ...overrides,
  };
}

describe('runTestGapAnalysis', () => {
  it('returns null when the provider cannot analyze test gaps', async () => {
    const result = await runTestGapAnalysis(baseOptions({ provider: { analyzeCode: async () => [] } }));
    expect(result).toBeNull();
  });

  it('returns null when there is no source under test', async () => {
    const result = await runTestGapAnalysis(
      baseOptions({
        changedPaths: ['README.md'],
        provider: { analyzeTestGaps: async () => [] },
      }),
    );
    expect(result).toBeNull();
  });

  it('runs the provider and records evidence on success', async () => {
    const analyzeTestGaps = vi.fn(async (input: TestGapInput) => {
      expect(input.changedSources).toEqual(['src/a.ts']);
      return [{ filePath: 'src/a.ts', scenario: 'handles empty input', expected: 'throws', confidence: 'HIGH' as const }];
    });

    const result = await runTestGapAnalysis(baseOptions({ provider: { analyzeTestGaps } }));

    expect(analyzeTestGaps).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ analyzed: true, scenarios: [{ scenario: 'handles empty input' }] });
    expect(result!.evidence.changedSources).toEqual(['src/a.ts']);
  });

  it('degrades to analyzed:false when the provider throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await runTestGapAnalysis(
      baseOptions({ provider: { analyzeTestGaps: async () => { throw new Error('model down'); } } }),
    );

    expect(result).toMatchObject({ analyzed: false, scenarios: [], reason: 'model down' });
    warn.mockRestore();
  });

  it('rethrows when the supplied signal was aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runTestGapAnalysis(
        baseOptions({
          signal: controller.signal,
          provider: { analyzeTestGaps: async () => { throw new Error('aborted'); } },
        }),
      ),
    ).rejects.toThrow('aborted');
  });
});

class FakeProvider extends BaseAiProvider {
  constructor(private readonly raw: unknown) {
    super('test-key');
  }

  async analyzeCode(): Promise<never[]> {
    return [];
  }

  protected async completeJson(_request: unknown): Promise<unknown> {
    return this.raw;
  }
}

describe('BaseAiProvider.analyzeTestGaps', () => {
  it('normalizes the raw provider JSON into scenarios', async () => {
    const provider = new FakeProvider({
      scenarios: [{ filePath: 'src/a.ts', scenario: 's', expected: 'e', confidence: 'LOW' }],
    });
    const scenarios = await provider.analyzeTestGaps({
      changedSources: ['src/a.ts'],
      changedTests: [],
      relatedTests: [],
      sourceExcerpts: [{ path: 'src/a.ts', content: 'code' }],
      relatedTestExcerpts: [],
      treeTruncated: false,
      incomplete: false,
    });

    expect(scenarios).toEqual([
      { filePath: 'src/a.ts', lineNumber: 1, scenario: 's', expected: 'e', confidence: 'LOW' },
    ]);
  });
});
