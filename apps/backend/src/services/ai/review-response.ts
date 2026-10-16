import { AiRequestError, MAX_AI_FINDINGS } from './ai-request-policy';

const FINDINGS_FIELDS = ['findings', 'suggestions', 'issues'] as const;

/** Model metadata and insertion order are never evidence of a clean review. */
export function extractReviewFindings(raw: unknown): unknown[] {
  let findings: unknown = raw;
  if (!Array.isArray(raw) && raw && typeof raw === 'object') {
    const fields = FINDINGS_FIELDS.filter(field => Object.hasOwn(raw, field));
    // Conflicting aliases can otherwise hide real findings behind an empty
    // array. Fail explicitly rather than choosing, merging, or guessing.
    if (fields.length !== 1) throw new AiRequestError('ai-invalid-response');
    findings = (raw as Record<string, unknown>)[fields[0]!];
  }
  if (!Array.isArray(findings) || findings.length > MAX_AI_FINDINGS) throw new AiRequestError('ai-invalid-response');
  return findings;
}
