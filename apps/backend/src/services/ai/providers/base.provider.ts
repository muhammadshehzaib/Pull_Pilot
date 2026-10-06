import {
  AiSuggestion,
  FINDING_CATEGORIES,
  FINDING_SEVERITIES,
} from '../finding-taxonomy';
import { type ReviewContext, formatContextForPrompt } from '../context-prompt';

export type { AiSuggestion };
export { normalizeSuggestions } from '../finding-taxonomy';

/**
 * Ceiling on the context block that accompanies a diff.
 *
 * Context competes with the diff for the prompt budget. Keeping it bounded
 * here means a review with a huge repository can still afford room for the
 * actual diff, which is the thing under review.
 */
export const MAX_CONTEXT_CHARS = 60_000;

export abstract class BaseAiProvider {
  protected apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Core function implemented uniquely by each service (OpenAI, Gemini, etc)
   * but returning the exactly identical standard format.
   *
   * `context` is optional and additive: providers must degrade to a diff-only
   * review when it is absent or empty, so an older or failing context source
   * never blocks a review from running.
   */
  abstract analyzeCode(
    diff: string,
    customRules?: string[],
    context?: ReviewContext,
  ): Promise<AiSuggestion[]>;

  /**
   * Renders the context block appended to a user message, or an empty string.
   *
   * Context travels with the diff rather than in the system prompt so that
   * every provider needs only a single-line change and none of them can
   * accidentally send files without the rules governing how to use them —
   * those rules are emitted at the top of this same block.
   */
  protected renderContext(context: ReviewContext | undefined): string {
    return formatContextForPrompt(context, MAX_CONTEXT_CHARS);
  }

  protected getSystemPrompt(customRules: string[] = []): string {
    const basePrompt = `
      You are a strict, world-class software security and code quality auditor.
      Examine the following code diff and return structural improvements.
      Focus heavily on performance, memory optimization, clean architecture, and critical security bugs.

      OUTPUT FORMAT RULES:
      You MUST output STRICT, RAW JSON only. Do not output markdown formatting (like \`\`\`json).
      The response must be an array of objects.
      Format per object:
      {
        "filePath": "string",
        "lineNumber": number,
        "agentType": "${FINDING_CATEGORIES.join('" | "')}",
        "issue": "Concise description",
        "suggestion": "Clear solution snippet",
        "priority": "${FINDING_SEVERITIES.join('" | "')}"
      }

      SEVERITY GUIDE (priority):
      - CRITICAL: exploitable vulnerability, data loss/corruption, or a crash on a realistic input. Must be fixed before merge.
      - HIGH: clear bug or significant regression that will affect users or break a documented contract.
      - MEDIUM: real problem with a workaround, or a notable performance/robustness weakness.
      - LOW: maintainability, readability, or duplication issue worth fixing opportunistically.
      - INFO: purely informational observation, style preference, or optional hardening. Do not use INFO for real defects.

      CATEGORY GUIDE (agentType):
      - SECURITY: injection, authn/authz, secrets, unsafe deserialization, SSRF, XSS, crypto misuse.
      - BUG: will misbehave at runtime — null dereference, wrong condition, off-by-one, broken state.
      - CORRECTNESS: logic that is wrong but not immediately crashing — bad bounds, wrong formula, incorrect edge-case handling.
      - PERFORMANCE: slow paths, unnecessary re-renders, N+1 queries, leaks, blocking the event loop.
      - ARCHITECTURE: coupling, layering violations, unclear boundaries, non-extensible design.
      - MAINTAINABILITY: dead code, duplication, poor naming, missing types, hard-to-extend logic.
      - STYLE: purely cosmetic — formatting, import ordering, whitespace. Never use this to report a real defect.
      - TESTING: missing or weak test coverage for the changed behavior, flaky-test causes.

      CALIBRATION RULES (these decide whether the review is worth reading):
      - Only report a finding you can point at a specific changed line for. Never speculate about code you cannot see.
      - One finding per distinct problem. Reporting the same defect once per line is a failure, not thoroughness.
      - Before writing a finding, state the input or sequence that triggers it. If you cannot, downgrade to INFO or drop it.
      - CRITICAL and HIGH both require a concrete failure scenario. No scenario means it is MEDIUM at most.
      - A finding you cannot anchor to a line in this diff is not a finding. Drop it.
      - Prefer five findings you would defend in person over twenty you would apologise for.
      - If the diff has no meaningful issues, return an empty array []. An empty array is a valid, useful review.
    `;

    const rulesInjection = customRules.length > 0
      ? `\nADDITIONAL USER RULES TO ENFORCE:\nEach rule below is binding. When a changed line breaks one, report it as a finding and quote the rule in the issue text:\n${customRules
          .map((rule) => `- ${rule}`)
          .join('\n')}`
      : '';

    return basePrompt + rulesInjection;
  }
}