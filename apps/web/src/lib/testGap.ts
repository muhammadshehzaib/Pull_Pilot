/**
 * Test-gap vocabulary for the web app.
 *
 * Mirrors `apps/backend/src/services/test-gap/test-gap-types.ts`. A test-gap
 * report is advisory: it lists tests the worker believes the change is missing.
 * Nothing is executed by this analysis. V2 risk gives gaps advisory weights; the UI
 * presents it as suggestions rather than failures.
 */

export type TestGapConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface TestGapScenario {
  /** A changed source file — the provider may only cite paths discovery saw. */
  filePath: string;
  lineNumber: number;
  scenario: string;
  expected: string;
  edgeCase?: string;
  confidence: TestGapConfidence;
}

/** What discovery actually inspected, so the UI can flag a partial view. */
export interface TestGapEvidence {
  changedSources: string[];
  relatedTests: string[];
  treeTruncated: boolean;
  incomplete: boolean;
}

/** Persisted report. `analyzed: false` means the model step did not run. */
export interface TestGapReport {
  scenarios: TestGapScenario[];
  evidence: TestGapEvidence;
  analyzed: boolean;
  reason?: string;
}

export const CONFIDENCE_LABELS: Record<TestGapConfidence, string> = {
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

export const CONFIDENCE_COLORS: Record<TestGapConfidence, string> = {
  HIGH: 'var(--warning)',
  MEDIUM: 'var(--accent)',
  LOW: 'var(--text-secondary)',
};

/** Label for an arbitrary confidence string. Unknown values read as-is. */
export function confidenceLabel(confidence: string): string {
  return CONFIDENCE_LABELS[confidence as TestGapConfidence] ?? confidence;
}

/**
 * True when there is a report worth rendering. A report whose analysis failed
 * (`analyzed: false`) with no scenarios is not worth a card — the review simply
 * ran without this optional step.
 */
export function hasTestGaps(report: TestGapReport | null | undefined): boolean {
  return Boolean(report && (report.scenarios?.length > 0 || report.analyzed === false));
}

/**
 * A one-line summary for the card header, covering both "found gaps" and the
 * "we could not look" cases so an empty card never looks like a clean bill.
 */
export function testGapSummary(report: TestGapReport): string {
  if (report.analyzed === false) {
    return 'Test-gap analysis could not run for this review.';
  }
  const count = report.scenarios?.length ?? 0;
  if (count === 0) {
    return report.evidence?.incomplete
      ? 'No missing tests suggested — but the repository view was partial.'
      : 'No missing tests suggested for the changed files.';
  }
  return `${count} missing test scenario${count === 1 ? '' : 's'} suggested.`;
}
