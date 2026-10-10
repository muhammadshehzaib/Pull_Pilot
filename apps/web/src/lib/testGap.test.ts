import { describe, it, expect } from 'vitest';
import {
  confidenceLabel,
  hasTestGaps,
  testGapSummary,
  CONFIDENCE_COLORS,
  type TestGapReport,
} from './testGap';

function report(overrides: Partial<TestGapReport> = {}): TestGapReport {
  return {
    analyzed: true,
    scenarios: [],
    evidence: { changedSources: ['src/a.ts'], relatedTests: [], treeTruncated: false, incomplete: false },
    ...overrides,
  };
}

describe('confidence labels', () => {
  it('labels known confidences and passes unknown ones through', () => {
    expect(confidenceLabel('HIGH')).toBe('High');
    expect(confidenceLabel('LOW')).toBe('Low');
    expect(confidenceLabel('UNSURE')).toBe('UNSURE');
  });

  it('has a colour per confidence', () => {
    expect(CONFIDENCE_COLORS.HIGH).toBeTruthy();
    expect(CONFIDENCE_COLORS.MEDIUM).toBeTruthy();
    expect(CONFIDENCE_COLORS.LOW).toBeTruthy();
  });
});

describe('hasTestGaps', () => {
  it('is false for null/undefined and for a clean report', () => {
    expect(hasTestGaps(null)).toBe(false);
    expect(hasTestGaps(undefined)).toBe(false);
    expect(hasTestGaps(report())).toBe(false);
  });

  it('is true when scenarios exist', () => {
    expect(
      hasTestGaps(report({ scenarios: [{ filePath: 'a.ts', lineNumber: 1, scenario: 's', expected: 'e', confidence: 'HIGH' }] })),
    ).toBe(true);
  });

  it('is true when the analysis failed, so the gap is visible', () => {
    expect(hasTestGaps(report({ analyzed: false, reason: 'model down' }))).toBe(true);
  });
});

describe('testGapSummary', () => {
  it('reports the failed-analysis case', () => {
    expect(testGapSummary(report({ analyzed: false }))).toContain('could not run');
  });

  it('reports a clean result', () => {
    expect(testGapSummary(report())).toContain('No missing tests');
  });

  it('flags a partial view when there are no scenarios', () => {
    const partial = report({
      evidence: { changedSources: ['a.ts'], relatedTests: [], treeTruncated: true, incomplete: true },
    });
    expect(testGapSummary(partial)).toContain('partial');
  });

  it('counts scenarios with correct singular/plural', () => {
    const one = report({ scenarios: [{ filePath: 'a.ts', lineNumber: 1, scenario: 's', expected: 'e', confidence: 'HIGH' }] });
    expect(testGapSummary(one)).toBe('1 missing test scenario suggested.');
    const two = report({
      scenarios: [
        { filePath: 'a.ts', lineNumber: 1, scenario: 's', expected: 'e', confidence: 'HIGH' },
        { filePath: 'b.ts', lineNumber: 2, scenario: 't', expected: 'e', confidence: 'LOW' },
      ],
    });
    expect(testGapSummary(two)).toBe('2 missing test scenarios suggested.');
  });
});
