import { describe, expect, it } from 'vitest';
import { assessExplainableRisk, assessRisk, RISK_V2_THRESHOLDS } from './risk-engine';
import { deduplicate } from '../ai/finding-dedup.service';
import { normalizeStoredSuggestions, type AiSuggestion } from '../ai/finding-taxonomy';
import { baselineBehavioral, withExecution } from '../behavioral/contracts';
import type { TestGapReport } from '../test-gap/test-gap-types';
const finding = (extra: Partial<AiSuggestion> = {}): AiSuggestion => ({ filePath: 'a.ts', lineNumber: 1, agentType: 'BUG', priority: 'MEDIUM', issue: 'missing validation', suggestion: 'validate it', source: 'LLM', ...extra });
const gap: TestGapReport = { analyzed: true, scenarios: [{ filePath: 'a.ts', lineNumber: 1, scenario: 'handles empty cart', expected: 'empty', confidence: 'HIGH' }], evidence: { changedSources: ['a.ts'], relatedTests: ['a.test.ts'], incomplete: false, treeTruncated: false } };
const baseline = baselineBehavioral(gap);
const evidence = (status: 'PASSED' | 'FAILED' | 'ERROR' | 'TIMED_OUT' | 'NOT_RUN') => withExecution(baseline, [{ id: baseline.scenarios[0].id, status, steps: status === 'PASSED' || status === 'FAILED' ? [{ index: 0, status: 'PASSED' }, { index: 1, status }] : [] }], { id: 'run', headSha: 'sha', ciRunId: '1' });
describe('explainable risk v2', () => {
  it('extends legacy reporting with explicit score direction, thresholds and advisory enforcement', () => {
    const legacy = assessRisk([finding()]).report;
    const report = assessExplainableRisk([finding()]);
    expect(report).toMatchObject({ version: 2, direction: 'HIGHER_IS_RISKIER', enforcement: 'ADVISORY', score: legacy.score, thresholds: { review: 25, block: 75 } });
    expect(report.reasons.join(' ')).toMatch(/no GitHub merge protection/);
  });
  it('scores duplicate findings once and preserves cross-detector corroboration', () => {
    const input = [finding({ source: 'LLM' }), finding({ source: 'SAST', priority: 'HIGH' })];
    const direct = assessExplainableRisk(input);
    expect(direct.score).toBe(15); expect(direct.duplicateCount).toBe(1); expect(direct.corroboratedCount).toBe(1);
    expect(direct.factors[0].sources.sort()).toEqual(['LLM', 'SAST']);
    const persisted = normalizeStoredSuggestions(deduplicate(input));
    expect(assessExplainableRisk(persisted).score).toBe(15);
    expect(assessExplainableRisk(persisted).corroboratedCount).toBe(1);
    expect(input[0].sources).toBeUndefined();
  });
  it('does not corroborate distinct defects merely because their lines are nearby', () => {
    const report = assessExplainableRisk([finding({ source: 'LLM' }), finding({ source: 'SAST', issue: 'unsafe SQL', lineNumber: 2 })]);
    expect(report.score).toBe(12); expect(report.corroboratedCount).toBe(0);
  });
  it('keeps distinct case-sensitive file paths separate', () => expect(assessExplainableRisk([finding({ filePath: 'A.ts' }), finding()]).score).toBe(12));
  it.each([{ score: 24, verdict: 'SAFE' }, { score: 25, verdict: 'REVIEW' }, { score: 74, verdict: 'REVIEW' }, { score: 75, verdict: 'BLOCK' }, { score: 100, verdict: 'BLOCK' }])('tests the exact $score boundary', ({ score, verdict }) => {
    const findings: AiSuggestion[] = Array.from({ length: Math.floor(score / 2) }, (_, n) => finding({ filePath: `${n}.ts`, priority: 'LOW' }));
    const options = score % 2 ? { testGaps: { ...gap, scenarios: [{ ...gap.scenarios[0], confidence: 'MEDIUM' as const }] } } : {};
    expect(assessExplainableRisk(findings, options)).toMatchObject({ score, verdict });
    expect(RISK_V2_THRESHOLDS).toEqual({ review: 25, block: 75 });
  });
  it('caps the score at 100 without hiding the contribution total', () => {
    const report = assessExplainableRisk(Array.from({ length: 5 }, (_, n) => finding({ filePath: `${n}.ts`, priority: 'CRITICAL' })));
    expect(report.score).toBe(100); expect(report.unclampedScore).toBe(150);
  });
  it('preserves deterministic blocking and explicit secret policy exceptions', () => {
    expect(assessExplainableRisk([finding({ source: 'SAST', priority: 'CRITICAL' })]).verdict).toBe('BLOCK');
    expect(assessExplainableRisk([finding({ source: 'SECRETS', priority: 'LOW' })]).verdict).toBe('BLOCK');
    expect(assessExplainableRisk([finding({ source: 'SECRETS', priority: 'LOW' })], { blockOnCriticalSecret: false }).verdict).toBe('SAFE');
  });
  it('counts rules through findings once and adds only unrepresented failed checks', () => {
    const ruleChecks = [{ ruleId: 'r', status: 'FAIL' as const, violationCount: 1 }];
    expect(assessExplainableRisk([finding({ source: 'RULES', ruleKeys: ['r'] })], { ruleChecks }).score).toBe(6);
    expect(assessExplainableRisk([], { ruleChecks })).toMatchObject({ score: 6, verdict: 'REVIEW' });
  });
});
describe('risk evidence distinctions', () => {
  it('weights advisory gaps below executed failures and never treats generated plans as failures', () => {
    const advisory = assessExplainableRisk([], { testGaps: gap, behavioral: baseline });
    const failed = assessExplainableRisk([], { testGaps: gap, behavioral: evidence('FAILED') });
    const passed = assessExplainableRisk([], { testGaps: gap, behavioral: evidence('PASSED') });
    expect(advisory.score).toBe(2); expect(advisory.coverage.behavioral.executed).toBe(0);
    expect(failed.score).toBe(15); expect(failed.verdict).toBe('REVIEW'); expect(failed.factors).toHaveLength(1);
    expect(passed.score).toBe(0); expect(passed.coverage.behavioral.verified).toBe(1);
    for (const status of ['NOT_RUN', 'ERROR', 'TIMED_OUT'] as const) {
      const report = assessExplainableRisk([], { testGaps: gap, behavioral: evidence(status) });
      expect(report.score).toBe(2); expect(report.coverage.behavioral.verified).toBe(0);
    }
  });
  it('a later error does not erase an earlier executed failure', () => {
    const failed = evidence('FAILED');
    const later = withExecution(failed, [{ id: baseline.scenarios[0].id, status: 'ERROR', steps: [] }], { id: 'later', headSha: 'sha', ciRunId: '2' });
    const report = assessExplainableRisk([], { testGaps: gap, behavioral: later });
    expect(report.score).toBe(15); expect(report.coverage.behavioral.errors).toBe(1); expect(report.coverage.behavioral.failed).toBe(1);
  });
  it('corroborates an identically described failure rather than counting the defect twice', () => {
    const report = assessExplainableRisk([finding({ issue: gap.scenarios[0].scenario, priority: 'HIGH' })], { testGaps: gap, behavioral: evidence('FAILED') });
    expect(report.score).toBe(15); expect(report.factors).toHaveLength(1); expect(report.factors[0].corroborated).toBe(true);
  });
  it('missing/degraded scans affect confidence and never reduce finding points', () => {
    const missing = assessExplainableRisk([finding({ priority: 'HIGH' })]);
    const partial = assessExplainableRisk([finding({ priority: 'HIGH' })], { includedFiles: ['a.ts'], securityChecks: [{ probe: 'SAST', ruleKey: 'sast', ruleName: 'SAST', status: 'DEGRADED', findingCount: 0 }] });
    expect(missing.score).toBe(15); expect(missing.coverage.confidence).toBe('LOW');
    expect(partial.score).toBe(15); expect(partial.coverage.security.SAST).toBe('PARTIAL');
    expect(partial.coverage.missingEvidence.join(' ')).toMatch(/no pass is inferred/);
  });
  it('reports complete scoped evidence separately from score and retains failures in confidence', () => {
    const securityChecks = (['SAST', 'SECRETS', 'DEPENDENCIES'] as const).map(probe => ({ probe, ruleKey: probe, ruleName: probe, status: 'PASS' as const, findingCount: 0 }));
    const report = assessExplainableRisk([], { includedFiles: ['a.ts'], securityChecks, context: 'AVAILABLE', testGaps: gap, behavioral: evidence('FAILED') });
    expect(report.coverage.confidence).toBe('HIGH'); expect(report.score).toBe(15); expect(report.verdict).toBe('REVIEW');
  });
});
