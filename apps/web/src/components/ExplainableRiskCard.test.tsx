import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ExplainableRiskCard } from './ExplainableRiskCard';
import { normalizeBehavioral } from '../lib/behavioral';
const report = { version: 2, direction: 'HIGHER_IS_RISKIER', enforcement: 'ADVISORY', score: 15, verdict: 'REVIEW', thresholds: { review: 25, block: 75 }, unclampedScore: 15, factors: [{ id: 'x', kind: 'BEHAVIORAL_FAILURE', points: 15, sources: ['OWNER_CI'], corroborated: false, explanation: 'Executed assertion failed.' }], factorsOmitted: 0, duplicateCount: 1, reasons: [], coverage: { scope: 'CHANGED_FILES_ONLY', includedFiles: 1, ignoredFiles: 2, security: { SAST: 'PARTIAL', SECRETS: 'FULL', DEPENDENCIES: 'NOT_RUN' }, rules: { executed: 1, failed: 0, skipped: 1 }, context: 'PARTIAL', testGaps: 'AVAILABLE', behavioral: { generated: 2, executed: 1, verified: 0, failed: 1, notRun: 1, timedOut: 0, errors: 0 }, confidence: 'MEDIUM', missingEvidence: ['Dependencies were not scanned.'] } };
describe('explainable risk rendering', () => {
  it('shows direction, actual confidence, partial evidence and advisory enforcement', () => {
    render(<ExplainableRiskCard report={report} />);
    expect(screen.getByText(/0 means lower indicated risk/)).toBeTruthy();
    expect(screen.getByText(/does not enforce GitHub merge protection/)).toBeTruthy();
    expect(screen.getByText('MEDIUM')).toBeTruthy();
    expect(screen.getByText('Dependencies were not scanned.')).toBeTruthy();
    expect(screen.getByText(/Executed assertion failed/)).toBeTruthy();
    expect(screen.getByText(/1 not run/)).toBeTruthy();
  });
  it.each([undefined, { score: 0, verdict: 'SAFE' }, { ...report, version: 99 }, { ...report, score: NaN }, { ...report, coverage: {} }])('does not misrender legacy or invalid v2 data as a clean score', value => {
    expect(render(<ExplainableRiskCard report={value} />).container.textContent).toBe('');
  });
  it('does not upgrade missing or malformed behavioral records to verification', () => {
    expect(normalizeBehavioral(undefined)).toBeNull();
    expect(normalizeBehavioral({ version: 1, executor: 'OWNER_CI', scenarios: [{ id: 'x', description: 'x', filePath: 'a', status: 'unknown', stage: 'VERIFIED' }] })?.scenarios[0]).toMatchObject({ status: 'NOT_RUN', stage: 'GENERATED' });
  });
});
