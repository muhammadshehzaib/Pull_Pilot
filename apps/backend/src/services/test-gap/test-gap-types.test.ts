import { describe, it, expect } from 'vitest';
import { normalizeTestGapScenarios } from './test-gap-types';

describe('normalizeTestGapScenarios', () => {
  it('keeps well-formed scenarios and defaults confidence to MEDIUM', () => {
    const out = normalizeTestGapScenarios([
      {
        filePath: 'src/db.ts',
        lineNumber: 12,
        scenario: 'rejects an empty id',
        expected: 'throws a ValidationError',
        confidence: 'HIGH',
      },
      { filePath: 'src/api.ts', scenario: 'handles a 500 from upstream' },
    ]);

    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      filePath: 'src/db.ts',
      lineNumber: 12,
      scenario: 'rejects an empty id',
      expected: 'throws a ValidationError',
      confidence: 'HIGH',
    });
    // No `expected` given: falls back to the scenario text, lineNumber to 1.
    expect(out[1]).toEqual({
      filePath: 'src/api.ts',
      lineNumber: 1,
      scenario: 'handles a 500 from upstream',
      expected: 'handles a 500 from upstream',
      confidence: 'MEDIUM',
    });
  });

  it('unwraps a response the model nested under a key', () => {
    const out = normalizeTestGapScenarios({
      scenarios: [{ filePath: 'a.ts', scenario: 's', expected: 'e' }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].filePath).toBe('a.ts');
  });

  it('accepts common field synonyms and an edge case', () => {
    const out = normalizeTestGapScenarios([
      { file: 'a.ts', line: '5', description: 'empty input', assertion: 'throws', edge_case: '""' },
    ]);
    expect(out[0]).toMatchObject({
      filePath: 'a.ts',
      lineNumber: 5,
      scenario: 'empty input',
      expected: 'throws',
      edgeCase: '""',
    });
  });

  it('coerces an unknown confidence to MEDIUM', () => {
    const out = normalizeTestGapScenarios([{ filePath: 'a.ts', scenario: 's', confidence: 'SURE' }]);
    expect(out[0].confidence).toBe('MEDIUM');
  });

  it('drops entries without a path or scenario and never throws on junk', () => {
    const out = normalizeTestGapScenarios([
      null,
      42,
      { filePath: 'a.ts' },
      { scenario: 'no path' },
      { filePath: 'ok.ts', scenario: 'kept' },
    ] as unknown[]);
    expect(out.map((s) => s.filePath)).toEqual(['ok.ts']);
    expect(normalizeTestGapScenarios('not json')).toEqual([]);
  });

  it('caps the number of scenarios', () => {
    const raw = Array.from({ length: 50 }, (_, i) => ({ filePath: `f${i}.ts`, scenario: `s${i}` }));
    expect(normalizeTestGapScenarios(raw)).toHaveLength(8);
    expect(normalizeTestGapScenarios(raw).length).toBeLessThanOrEqual(8);
  });
});
