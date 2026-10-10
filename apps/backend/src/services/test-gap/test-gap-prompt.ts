import type { TestGapInput } from './test-gap-types';

/**
 * The system prompt for test-gap analysis.
 *
 * Kept separate from the review prompt because the task is different: the
 * reviewer judges a change, whereas this step only asks what is *not* tested.
 * Framing it as its own task stops the model from re-reporting the same bugs it
 * already reported as findings.
 */
export const TEST_GAP_SYSTEM_PROMPT = `You are a meticulous test engineer. Identify the most valuable MISSING tests for a code change.

You are given the changed source files and any existing tests that relate to them. You do NOT run tests and you do NOT rewrite production code.

Return only test scenarios that are genuinely missing and cover behaviour a reviewer would care about: edge cases, error paths, boundary values, invalid input, concurrency, and security-relevant inputs. Do not restate tests that already exist.

OUTPUT FORMAT RULES:
You MUST output STRICT, RAW JSON only — no markdown fences, no commentary, no trailing text.
Return a JSON array. Each object has exactly this shape:
{
  "filePath": "a path from CHANGED SOURCE FILES",
  "lineNumber": 0,
  "scenario": "one-line description of the missing test",
  "expected": "what the test should assert",
  "edgeCase": "optional concrete input or condition that makes it interesting",
  "confidence": "HIGH" | "MEDIUM" | "LOW"
}

RULES:
- Only use filePath values that appear under CHANGED SOURCE FILES. Never invent paths.
- One scenario per distinct gap. No duplicates.
- If the change is already well covered by the listed tests, return [].
- Return at most 8 scenarios, most valuable first.`;

/**
 * Renders the user message: the inventories first, then the actual code, so a
 * model reading top-to-bottom knows what it is looking at before the excerpts.
 */
export function buildTestGapPrompt(input: TestGapInput): string {
  const parts: string[] = [];

  parts.push('CHANGED SOURCE FILES:');
  parts.push(input.changedSources.length > 0 ? input.changedSources.map((p) => `- ${p}`).join('\n') : '- (none)');

  if (input.changedTests.length > 0) {
    parts.push('');
    parts.push('TEST FILES ALREADY CHANGED (the author added or updated tests here):');
    parts.push(input.changedTests.map((p) => `- ${p}`).join('\n'));
  }

  if (input.relatedTests.length > 0) {
    parts.push('');
    parts.push('EXISTING RELATED TESTS (may already cover part of the change):');
    parts.push(input.relatedTests.map((p) => `- ${p}`).join('\n'));
  }

  if (input.incomplete || input.treeTruncated) {
    parts.push('');
    parts.push(
      'NOTE: the repository listing or file contents were only partially available, so treat this view as incomplete.',
    );
  }

  for (const file of input.sourceExcerpts) {
    parts.push('');
    parts.push(`--- CHANGED SOURCE: ${file.path} ---`);
    parts.push(file.content);
  }

  for (const file of input.relatedTestExcerpts) {
    parts.push('');
    parts.push(`--- EXISTING TEST: ${file.path} ---`);
    parts.push(file.content);
  }

  parts.push('');
  parts.push('Return the JSON array of missing test scenarios now.');

  return parts.join('\n');
}
