import { describe, it, expect } from 'vitest';
import { buildTestDraftPrompt, TEST_DRAFT_SYSTEM_PROMPT } from './test-draft-prompt';
import { BaseAiProvider } from '../ai/providers/base.provider';
import type { TestDraftInput } from './test-draft-types';

const input: TestDraftInput = {
  changedSources: ['src/a.ts'],
  changedTests: [],
  relatedTests: ['tests/a.test.ts'],
  sourceExcerpts: [{ path: 'src/a.ts', content: 'export const a = 1;' }],
  relatedTestExcerpts: [{ path: 'tests/a.test.ts', content: 'it("x", () => {})' }],
  treeTruncated: false,
  incomplete: false,
  scenario: {
    filePath: 'src/a.ts',
    lineNumber: 3,
    scenario: 'handles empty input',
    expected: 'throws',
    confidence: 'HIGH',
  },
  framework: 'vitest',
};

describe('buildTestDraftPrompt', () => {
  it('includes the scenario, framework, and code excerpts', () => {
    const prompt = buildTestDraftPrompt(input);
    expect(prompt).toContain('handles empty input');
    expect(prompt).toContain('DETECTED TEST FRAMEWORK: vitest');
    expect(prompt).toContain('--- SOURCE UNDER TEST: src/a.ts ---');
    expect(prompt).toContain('--- EXISTING TEST: tests/a.test.ts ---');
  });

  it('flags a partial view', () => {
    const prompt = buildTestDraftPrompt({ ...input, incomplete: true });
    expect(prompt).toMatch(/partially available/i);
  });
});

describe('TEST_DRAFT_SYSTEM_PROMPT', () => {
  it('instructs the model to admit insufficient context instead of guessing', () => {
    expect(TEST_DRAFT_SYSTEM_PROMPT).toMatch(/insufficientContext/);
    expect(TEST_DRAFT_SYSTEM_PROMPT).toMatch(/NEVER invent/i);
  });
});

class FakeProvider extends BaseAiProvider {
  constructor(private readonly raw: unknown) {
    super('test-key');
  }

  async analyzeCode(): Promise<never[]> {
    return [];
  }

  protected async completeJson(): Promise<unknown> {
    return this.raw;
  }
}

describe('BaseAiProvider.generateTestDraft', () => {
  it('normalizes a usable draft', async () => {
    const provider = new FakeProvider({ targetPath: 'tests/a.test.ts', content: 'body' });
    await expect(provider.generateTestDraft(input)).resolves.toMatchObject({
      targetPath: 'tests/a.test.ts',
      content: 'body',
    });
  });

  it('carries an insufficiency signal through', async () => {
    const provider = new FakeProvider({ insufficientContext: true, reason: 'missing fixture' });
    await expect(provider.generateTestDraft(input)).resolves.toMatchObject({
      insufficient: true,
      reason: 'missing fixture',
    });
  });
});
