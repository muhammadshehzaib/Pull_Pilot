import { describe, expect, it } from 'vitest';
import { deriveRecommendations, mayDeprioritize, presentationAdaptation, type FeedbackEvidence } from './adaptation-policy';
import type { AiSuggestion } from '../ai/finding-taxonomy';
import { generateFingerprint } from '../historical/fingerprint.service';
import { assessExplainableRisk } from '../security/risk-engine';

const finding: AiSuggestion = { filePath: 'src/Auth.ts', lineNumber: 10, agentType: 'STYLE', priority: 'LOW',
  issue: 'Naming convention mismatch', suggestion: 'Use team naming', source: 'LLM' };
const row = (pr: number, disposition = 'REJECTED', reason = 'STYLE_PREFERENCE', updatedAt = new Date('2026-01-02')): FeedbackEvidence => ({
  fingerprint: generateFingerprint(finding), analysisJob: { referenceId: String(pr) },
  feedback: { disposition, rejectionReason: disposition === 'REJECTED' ? reason : null, updatedAt }, expiresAt: new Date('2099-01-01'),
});
describe('feedback_v1 policy', () => {
  it('requires five reviewed PRs, with 80% sharing one reason', () => {
    expect(deriveRecommendations([row(1), row(2), row(3), row(4)])).toEqual([]);
    expect(deriveRecommendations([row(1), row(2), row(3), row(4), row(5, 'ACCEPTED')])[0]).toMatchObject({ reviewedPrs: 5, rejectedPrs: 4, reason: 'STYLE_PREFERENCE' });
    expect(deriveRecommendations([row(1), row(2), row(3), row(4, 'ACCEPTED'), row(5, 'ACCEPTED')])).toEqual([]);
  });
  it('does not add retries, duplicate findings, or split rejection reasons', () => {
    expect(deriveRecommendations(Array.from({ length: 20 }, () => row(1)))).toEqual([]);
    expect(deriveRecommendations([row(1), row(2), row(3), row(4, 'REJECTED', 'FALSE_POSITIVE'), row(5, 'REJECTED', 'DUPLICATE')])).toEqual([]);
  });
  it('latest explicit assessment and resets replace older assessments per PR', () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(i));
    expect(deriveRecommendations(rows)).toHaveLength(1);
    expect(deriveRecommendations([...rows, row(0, 'UNREVIEWED', '', new Date('2026-01-03'))])).toEqual([]);
    expect(deriveRecommendations([...rows, row(0, 'ACCEPTED', '', new Date('2026-01-03')), row(1, 'ACCEPTED', '', new Date('2026-01-03'))])).toEqual([]);
  });
  it('silence and needs-review are not positive or negative votes', () => {
    expect(deriveRecommendations([row(0), row(1), row(2), row(3), row(4, 'NEEDS_REVIEW'), { ...row(5), feedback: null }])).toEqual([]);
  });
  it('uses earliest evidence expiry and preserves path case', () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(i)); rows[0].expiresAt = new Date('2098-02-01');
    expect(deriveRecommendations(rows)[0].expiresAt).toBe('2098-02-01T00:00:00.000Z');
    expect(deriveRecommendations(rows, new Date('2098-02-01'))).toEqual([]);
    expect(generateFingerprint({ ...finding, filePath: 'src/auth.ts' })).not.toBe(generateFingerprint(finding));
  });
  it.each(['FALSE_POSITIVE', 'INTENDED_BEHAVIOR', 'STYLE_PREFERENCE', 'DUPLICATE', 'OUT_OF_SCOPE', 'OTHER'])('explains reason %s without conflating it with false positives', reason => {
    const recommendations = deriveRecommendations(Array.from({ length: 5 }, (_, i) => row(i, 'REJECTED', reason)));
    expect(recommendations[0].reason).toBe(reason);
    expect(presentationAdaptation([finding], recommendations)).toHaveLength(reason === 'OTHER' ? 0 : 1);
  });
  it.each([
    { agentType: 'SECURITY' }, { priority: 'HIGH' }, { priority: 'CRITICAL' }, { priority: 'MEDIUM' },
    { agentType: 'BUG' }, { agentType: 'CORRECTNESS' }, { source: 'SAST' }, { source: 'SECRETS' },
    { source: 'DEPENDENCIES' }, { source: 'RULES' }, { corroborated: true }, { sources: ['LLM', 'SAST'] },
  ])('protects evidence-backed or non-advisory findings: %j', override => {
    expect(mayDeprioritize({ ...finding, ...override } as AiSuggestion)).toBe(false);
  });
  it('does not mutate findings, severity, or risk', () => {
    const findings = [finding]; const before = JSON.stringify(findings); const risk = assessExplainableRisk(findings);
    const recommendations = deriveRecommendations(Array.from({ length: 5 }, (_, i) => row(i)));
    expect(presentationAdaptation(findings, recommendations)).toHaveLength(1);
    expect(JSON.stringify(findings)).toBe(before);
    expect(assessExplainableRisk(findings)).toEqual(risk);
  });
});
