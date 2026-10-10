import type { TestGapInput, TestGapScenario } from './test-gap-types';

/**
 * Vocabulary for AI-drafted tests.
 *
 * A draft is the *opposite* of a test-gap scenario: the gap step only names a
 * missing test, while a draft contains the actual test body. That difference
 * matters for safety — a draft is authored by the model and, if the user asks,
 * committed to a branch. So the shape here is deliberately narrow: one file, one
 * path, and an explicit "I cannot do this" branch the model must be able to take
 * instead of inventing project APIs it never saw.
 */

/** Ceiling on a drafted file's size. A model that ignores the prompt must not
 * be able to produce something we would then try to commit. */
export const MAX_TEST_DRAFT_BYTES = 200_000;

/** The context bundle handed to the model when drafting one test. */
export interface TestDraftInput extends TestGapInput {
  scenario: TestGapScenario;
  /** Best-effort framework hint (e.g. "vitest", "pytest") or undefined. */
  framework?: string;
}

/** A usable draft: a repo-relative test path plus the file body. */
export interface TestDraftContent {
  targetPath: string;
  content: string;
  framework?: string;
  notes?: string;
}

/** The model could not draft a test from what it was given. Nothing is invented. */
export interface TestDraftInsufficient {
  insufficient: true;
  reason: string;
}

export type TestDraftResult = TestDraftContent | TestDraftInsufficient;

export function isInsufficient(result: TestDraftResult): result is TestDraftInsufficient {
  return (result as TestDraftInsufficient).insufficient === true;
}

/** Unwraps the common envelopes providers wrap a single object in. */
function unwrap(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  for (const key of ['draft', 'file', 'test', 'result', 'data']) {
    const nested = obj[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return nested as Record<string, unknown>;
    }
  }
  return obj;
}

/**
 * Turns a raw provider payload into a usable draft or an explicit "not enough
 * context" result.
 *
 * Never invents: if the model gave no path or no body — or said it lacked
 * context — this returns the insufficient form rather than an empty file, so the
 * caller can show why instead of opening an empty editor.
 */
export function normalizeTestDraft(raw: unknown): TestDraftResult {
  const obj = unwrap(raw);
  if (!obj) {
    return { insufficient: true, reason: 'The model did not return a test draft.' };
  }

  const explicitInsufficient =
    obj.insufficientContext === true || obj.insufficient === true || obj.incomplete === true;
  const reason = firstString(obj.reason, obj.message, obj.explanation, obj.notes);

  if (explicitInsufficient) {
    return { insufficient: true, reason: reason || 'The model could not draft a test from the available context.' };
  }

  const targetPath = firstString(obj.targetPath, obj.path, obj.filePath, obj.testPath, obj.filename, obj.file);
  const content = firstString(obj.content, obj.code, obj.fileContent, obj.testCode, obj.body);

  if (!targetPath || !content) {
    return {
      insufficient: true,
      reason:
        reason ||
        (!content
          ? 'The model did not return test code for this scenario.'
          : 'The model did not propose a file path for the generated test.'),
    };
  }

  return {
    targetPath,
    content,
    ...(firstString(obj.framework, obj.testFramework, obj.frameworkName)
      ? { framework: firstString(obj.framework, obj.testFramework, obj.frameworkName) }
      : {}),
    ...(firstString(obj.notes, obj.explanation, obj.rationale)
      ? { notes: firstString(obj.notes, obj.explanation, obj.rationale) }
      : {}),
  };
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return '';
}

export function buildTestDraftInput(
  base: TestGapInput,
  scenario: TestGapScenario,
  framework?: string,
): TestDraftInput {
  return { ...base, scenario, ...(framework ? { framework } : {}) };
}
