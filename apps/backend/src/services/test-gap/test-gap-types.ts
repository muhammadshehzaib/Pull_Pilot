/**
 * Test-gap vocabulary.
 *
 * A test-gap report is advisory and additive: it names the tests a change is
 * missing so a reviewer can decide, in seconds, whether the author forgot an
 * edge case. It never runs tests, never edits the repository, and never affects
 * the risk verdict — the worst outcome of a wrong suggestion is a slightly
 * longer review, which is why the whole pipeline is best-effort and bounded.
 */

export type TestGapConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export const TEST_GAP_CONFIDENCES: readonly TestGapConfidence[] = ['HIGH', 'MEDIUM', 'LOW'];

/** Hard cap so one chatty model response cannot dominate the review payload. */
export const MAX_TEST_GAP_SCENARIOS = 8;

/** One missing test the model believes should exist for a changed source file. */
export interface TestGapScenario {
  /** A changed source file — never a path the model invented. */
  filePath: string;
  /** Best-effort line in the changed source, 1 when unknown. */
  lineNumber: number;
  /** One-line description of the missing test. */
  scenario: string;
  /** What the test should assert. */
  expected: string;
  /** Optional concrete input/condition that makes the test interesting. */
  edgeCase?: string;
  confidence: TestGapConfidence;
}

/**
 * What discovery actually looked at. Carried with the report so the UI can show
 * the difference between "no gaps" and "we could only see part of the repo".
 */
export interface TestGapEvidence {
  changedSources: string[];
  relatedTests: string[];
  treeTruncated: boolean;
  incomplete: boolean;
}

/** The full persisted report. `analyzed: false` means the model step did not run. */
export interface TestGapReport {
  scenarios: TestGapScenario[];
  evidence: TestGapEvidence;
  analyzed: boolean;
  /** Machine-ish reason when `analyzed` is false. */
  reason?: string;
}

/** Everything a provider needs to propose missing tests. */
export interface TestGapInput {
  changedSources: string[];
  changedTests: string[];
  /** Existing test files discovery matched to the change. */
  relatedTests: string[];
  sourceExcerpts: Array<{ path: string; content: string }>;
  relatedTestExcerpts: Array<{ path: string; content: string }>;
  treeTruncated: boolean;
  incomplete: boolean;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asPositiveInt(value: unknown): number {
  const n = typeof value === 'number' ? value : parseInt(String(value), 10);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function asConfidence(value: unknown): TestGapConfidence {
  const v = asString(value).toUpperCase();
  return (TEST_GAP_CONFIDENCES as readonly string[]).includes(v)
    ? (v as TestGapConfidence)
    : 'MEDIUM';
}

/** Returns the first array found inside an object, for models that wrap their output. */
function firstArrayValue(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  for (const value of Object.values(raw as Record<string, unknown>)) {
    if (Array.isArray(value)) return value;
  }
  return undefined;
}

/**
 * Coerces a raw model response into well-formed scenarios.
 *
 * Models disagree on field names and occasionally on the wrapper shape, so this
 * accepts the common synonyms, drops anything without a file path and a
 * scenario, and caps the list. It never throws: a malformed response yields an
 * empty list rather than failing the review.
 */
export function normalizeTestGapScenarios(raw: unknown): TestGapScenario[] {
  const list = Array.isArray(raw) ? raw : firstArrayValue(raw);
  if (!Array.isArray(list)) return [];

  const scenarios: TestGapScenario[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;

    const filePath = asString(obj.filePath ?? obj.file ?? obj.path);
    const scenario = asString(obj.scenario ?? obj.test ?? obj.description ?? obj.title ?? obj.case);
    const expected = asString(obj.expected ?? obj.assertion ?? obj.expectation ?? obj.expectedResult);
    if (!filePath || !scenario) continue;

    const edgeCase = asString(obj.edgeCase ?? obj.edge_case);
    scenarios.push({
      filePath,
      lineNumber: asPositiveInt(obj.lineNumber ?? obj.line ?? obj.line_no),
      scenario,
      expected: expected || scenario,
      ...(edgeCase ? { edgeCase } : {}),
      confidence: asConfidence(obj.confidence ?? obj.priority),
    });

    if (scenarios.length >= MAX_TEST_GAP_SCENARIOS) break;
  }

  return scenarios;
}
