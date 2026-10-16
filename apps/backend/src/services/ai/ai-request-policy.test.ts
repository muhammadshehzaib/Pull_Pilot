import { describe, expect, it } from 'vitest';
import { AiRequestError, assertReviewSize, assertAiPromptBudget, normalizeAiError, MAX_REVIEW_DIFF_BYTES,
  MAX_REVIEW_FILES, MAX_AI_PROMPT_BYTES } from './ai-request-policy';

describe('AI review admission and safe error classification', () => {
  it('accepts exact byte boundaries and rejects one additional byte', () => {
    expect(() => assertReviewSize('x'.repeat(MAX_REVIEW_DIFF_BYTES))).not.toThrow();
    expect(() => assertReviewSize('x'.repeat(MAX_REVIEW_DIFF_BYTES + 1))).toThrow(AiRequestError);
    expect(() => assertAiPromptBudget('x'.repeat(MAX_AI_PROMPT_BYTES - 1), 'y')).not.toThrow();
    expect(() => assertAiPromptBudget('x'.repeat(MAX_AI_PROMPT_BYTES), 'y')).toThrow(AiRequestError);
  });
  it('measures UTF-8 bytes rather than JavaScript string length', () => {
    const diff = '界'.repeat(Math.floor(MAX_REVIEW_DIFF_BYTES / 3) + 1);
    expect(diff.length).toBeLessThan(MAX_REVIEW_DIFF_BYTES);
    expect(() => assertReviewSize(diff)).toThrow(AiRequestError);
  });
  it('accepts 100 files and rejects 101 before filtering', () => {
    const diff = (count: number) => Array.from({ length: count }, (_, n) => `diff --git a/${n}.ts b/${n}.ts\n`).join('');
    expect(() => assertReviewSize(diff(MAX_REVIEW_FILES))).not.toThrow();
    expect(() => assertReviewSize(diff(MAX_REVIEW_FILES + 1))).toThrow(AiRequestError);
  });
  it.each([
    [{ status: 401 }, 'ai-invalid-key', false],
    [{ status: 403 }, 'ai-access-denied', false],
    [{ status: 402 }, 'ai-billing-required', false],
    [{ status: 400, errorDetails: [{ reason: 'API_KEY_INVALID' }] }, 'ai-invalid-key', false],
    [{ status: 400, error: { type: 'authentication_error' } }, 'ai-invalid-key', false],
    [{ status: 429, code: 'insufficient_quota' }, 'ai-billing-required', false],
    [{ status: 400 }, 'ai-invalid-request', false],
    [{ status: 404 }, 'ai-invalid-request', false],
    [{ status: 413 }, 'ai-invalid-request', false],
    [{ status: 408 }, 'ai-invalid-request', false],
    [{ status: 429 }, 'ai-rate-limited', true],
    [{ status: 503 }, 'ai-provider-unavailable', true],
    [{ code: 'ECONNRESET' }, 'ai-request-unconfirmed', false],
    [{ name: 'APIConnectionTimeoutError' }, 'ai-request-unconfirmed', false],
  ])('classifies structured failure %j as %s', (upstream, reason, retryable) => {
    const error = normalizeAiError('Claude', { ...upstream, message: 'private-key source-text', request: { secret: 'private-key' } });
    expect(error).toMatchObject({ reason, retryable });
    expect(error.message + JSON.stringify(error)).not.toContain('private-key');
    expect(error).not.toHaveProperty('cause');
  });
});
