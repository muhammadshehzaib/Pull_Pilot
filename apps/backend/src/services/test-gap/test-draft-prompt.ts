import type { TestDraftInput } from './test-draft-types';

/**
 * System prompt for drafting one missing test.
 *
 * The hard requirement is the last one: when the provided context is not enough
 * to write a test that would actually compile against the project's real APIs,
 * the model must say so rather than invent helpers, fixtures or imports. A
 * plausible-but-wrong test is worse than no test, and this draft may be
 * committed on the user's behalf.
 */
export const TEST_DRAFT_SYSTEM_PROMPT = `You are a senior test engineer. Write ONE test that covers a specific, missing scenario for a code change.

You are given the changed source file, any existing related tests, and the single scenario to cover. You write only the new test file's contents — never production code.

OUTPUT FORMAT RULES:
You MUST output STRICT, RAW JSON only — no markdown fences, no commentary.
Return a single JSON object, never an array:
{
  "targetPath": "repo/relative/path/to/new_or_existing_test_file",
  "content": "the full contents of the test file",
  "framework": "the test framework you used, e.g. vitest / jest / pytest",
  "notes": "optional one-line note for the developer"
}

RULES:
- Match the conventions of the EXISTING RELATED TESTS: same framework, import style, assertion library, file naming, and directory.
- Prefer extending an existing related test file over inventing a new one when one already covers this module.
- Only import modules and APIs that appear in the provided source or existing tests. NEVER invent project helpers, fixtures, factories, or exports you were not shown.
- The test must be self-contained and deterministic: no network, no sleeps, no reliance on ordering.
- Do not weaken or delete existing tests. If you extend a file, return its complete new contents.
- If the provided context is not enough to write a test that would compile against the real code, do NOT guess. Return:
  { "insufficientContext": true, "reason": "what is missing" }
- Write the test itself; do not output a diff or a patch.`;

/** Renders the user message: scenario first, then the bounded code excerpts. */
export function buildTestDraftPrompt(input: TestDraftInput): string {
  const parts: string[] = [];

  parts.push('SCENARIO TO COVER:');
  parts.push(`- Source file: ${input.scenario.filePath}`);
  if (input.scenario.lineNumber > 1) parts.push(`- Around line: ${input.scenario.lineNumber}`);
  parts.push(`- Missing test: ${input.scenario.scenario}`);
  parts.push(`- Expected behaviour: ${input.scenario.expected}`);
  if (input.scenario.edgeCase) parts.push(`- Edge case: ${input.scenario.edgeCase}`);
  parts.push(`- Confidence: ${input.scenario.confidence}`);

  if (input.framework) {
    parts.push('');
    parts.push(`DETECTED TEST FRAMEWORK: ${input.framework}`);
  }

  if (input.relatedTests.length > 0) {
    parts.push('');
    parts.push('EXISTING RELATED TEST FILES (match their conventions):');
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
    parts.push(`--- SOURCE UNDER TEST: ${file.path} ---`);
    parts.push(file.content);
  }

  for (const file of input.relatedTestExcerpts) {
    parts.push('');
    parts.push(`--- EXISTING TEST: ${file.path} ---`);
    parts.push(file.content);
  }

  parts.push('');
  parts.push('Return the JSON object with the single test draft now.');

  return parts.join('\n');
}
