import { describe, expect, it } from 'vitest';
import { extractReviewFindings } from './review-response';
import { MAX_AI_FINDINGS } from './ai-request-policy';

describe('named review response extraction', () => {
  it.each(['findings', 'suggestions', 'issues'])('selects %s by name, regardless of metadata type or position', field => {
    const findings = [{ issue: 'A real problem' }];
    for (const summary of ['Summary text', [], ['summary bullet'], { conclusion: 'Review finished' }, null]) {
      expect(extractReviewFindings({ summary, [field]: findings })).toBe(findings);
      expect(extractReviewFindings({ [field]: findings, summary })).toBe(findings);
    }
  });
  it('keeps top-level arrays and explicit empty findings', () => {
    const findings = [{ issue: 'A real problem' }];
    expect(extractReviewFindings(findings)).toBe(findings);
    expect(extractReviewFindings([])).toEqual([]);
    for (const field of ['findings', 'suggestions', 'issues']) {
      expect(extractReviewFindings({ summary: 'No issues', [field]: [] })).toEqual([]);
    }
  });
  it.each([
    { summary: 'No issues' }, { summary: [] }, { results: [] }, { data: { findings: [] } },
    { findings: null }, { findings: 'No issues' }, { findings: {} },
    { findings: [], suggestions: [{ issue: 'A real problem' }] },
    { suggestions: [{ issue: 'A real problem' }], findings: [] },
    { findings: [], issues: [] }, { findings: [], issues: 'Problem found' },
    null, 'No issues', 0,
  ])('rejects missing, malformed or ambiguous findings in %j', raw => {
    expect(() => extractReviewFindings(raw)).toThrow(expect.objectContaining({ reason: 'ai-invalid-response', retryable: false }));
  });
  it('does not treat an inherited findings field as an explicit response', () => {
    expect(() => extractReviewFindings(Object.create({ findings: [] }))).toThrow();
  });
  it('keeps the existing model findings limit for both response shapes', () => {
    const findings = Array.from({ length: MAX_AI_FINDINGS }, () => ({ issue: 'Problem' }));
    expect(extractReviewFindings({ summary: [], findings })).toHaveLength(MAX_AI_FINDINGS);
    findings.push({ issue: 'Extra problem' });
    expect(() => extractReviewFindings(findings)).toThrow();
    expect(() => extractReviewFindings({ summary: [], findings })).toThrow();
  });
});
