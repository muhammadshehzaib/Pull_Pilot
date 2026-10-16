export const MAX_REVIEW_DIFF_BYTES = 64 * 1024;
export const MAX_REVIEW_FILES = 100;
export const MAX_AI_PROMPT_BYTES = 96 * 1024;
export const MAX_AI_OUTPUT_TOKENS = 8192;
export const MAX_AI_FINDINGS = 10;

const messages = {
  'ai-review-too-large': 'This review exceeds 64 KiB of diff or 100 changed files. Split the change into smaller PRs before reviewing.',
  'ai-prompt-too-large': 'The AI request exceeds 96 KiB including code, context and rules. Split the PR or reduce surrounding context/rules before reviewing.',
  'ai-invalid-key': 'The AI API key is invalid or expired. Update it in API Key Vault (/vault), then start a new review.',
  'ai-access-denied': 'The AI provider denied access. Check your API key permissions and selected model, then start a new review.',
  'ai-billing-required': 'The AI provider requires billing or available credits. Check your provider account before starting another review.',
  'ai-invalid-request': 'The AI provider rejected this request. Check the selected model and split the PR or reduce its context before retrying manually.',
  'ai-response-truncated': 'The AI answer was cut off at its output/context limit. No complete AI review was produced. Automatic retries stopped to avoid repeating AI charges; split the PR before reviewing again.',
  'ai-response-blocked': 'The AI provider could not complete this review because its response was blocked. Automatic retries stopped.',
  'ai-invalid-response': 'The AI review returned invalid JSON or an empty/invalid response. Automatic retries stopped to avoid repeating AI charges; review the change before retrying manually.',
  'ai-rate-limited': 'The AI provider rate limit was reached. The review can retry after backoff.',
  'ai-provider-unavailable': 'The AI provider is temporarily unavailable. The review can retry after backoff.',
  'ai-request-unconfirmed': 'The AI request failed without a confirmed result. Automatic retries stopped to avoid possible repeated AI charges; check your provider before retrying manually.',
} as const;
export type AiFailureReason = keyof typeof messages;

/** Contains fixed user-safe metadata, never an upstream body, key or raw cause. */
export class AiRequestError extends Error {
  readonly retryable: boolean;
  constructor(public readonly reason: AiFailureReason, public readonly provider = 'AI', public readonly status?: number) {
    const prefix = provider === 'OpenAI' ? 'OpenAI Request Failed' : `${provider} API request failed`;
    super(`${prefix}: ${messages[reason]}`);
    this.name = 'AiRequestError';
    this.retryable = reason === 'ai-rate-limited' || reason === 'ai-provider-unavailable';
  }
}

export function assertReviewSize(diff: string): void {
  if (Buffer.byteLength(diff, 'utf8') > MAX_REVIEW_DIFF_BYTES ||
      (diff.match(/^diff --git /gm)?.length ?? 0) > MAX_REVIEW_FILES) {
    throw new AiRequestError('ai-review-too-large');
  }
}

export function assertAiPromptBudget(...parts: string[]): void {
  if (parts.reduce((sum, part) => sum + Buffer.byteLength(part, 'utf8'), 0) > MAX_AI_PROMPT_BYTES) {
    throw new AiRequestError('ai-prompt-too-large');
  }
}

export function parseAiJson(text: string): unknown {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 128 * 1024) {
    throw new AiRequestError('ai-invalid-response');
  }
  try { return JSON.parse(text); }
  catch { throw new AiRequestError('ai-invalid-response'); }
}

/** Check the termination signal even when the partial text happens to be JSON. */
export function assertAiCompletion(provider: string, reason: string | null | undefined): void {
  if (['max_tokens', 'model_context_window_exceeded', 'length', 'MAX_TOKENS'].includes(reason ?? '')) {
    throw new AiRequestError('ai-response-truncated', provider);
  }
  const completed = provider === 'Claude' ? ['end_turn'] : provider === 'Gemini' ? ['STOP'] : ['stop'];
  if (reason && !completed.includes(reason)) throw new AiRequestError('ai-response-blocked', provider);
}

export function normalizeAiError(provider: string, error: unknown): AiRequestError {
  if (error instanceof AiRequestError) return error.provider === 'AI'
    ? new AiRequestError(error.reason, provider, error.status) : error;
  const raw = error as any;
  const statusValue = raw?.status ?? raw?.statusCode ?? raw?.response?.status;
  const status = Number.isInteger(statusValue) ? statusValue : undefined;
  // SDK-specific structured codes only. Never inspect or echo arbitrary text
  // that can contain source citations, HTTP headers, URLs or customer keys.
  const codes = [raw?.code, raw?.error?.code, raw?.error?.type,
    ...(Array.isArray(raw?.errorDetails) ? raw.errorDetails.map((detail: any) => detail?.reason) : [])];
  if (status === 401 || codes.some(code => ['API_KEY_INVALID', 'API_KEY_EXPIRED', 'invalid_api_key', 'authentication_error'].includes(code))) {
    return new AiRequestError('ai-invalid-key', provider, status);
  }
  if (status === 403) return new AiRequestError('ai-access-denied', provider, status);
  if (status === 402 || codes.some(code => ['insufficient_quota', 'billing_error', 'credit_balance_too_low'].includes(code))) {
    return new AiRequestError('ai-billing-required', provider, status);
  }
  if (status === 429) return new AiRequestError('ai-rate-limited', provider, status);
  if (status !== undefined && status >= 500 && status <= 599) return new AiRequestError('ai-provider-unavailable', provider, status);
  if (status !== undefined && status >= 400 && status <= 499) return new AiRequestError('ai-invalid-request', provider, status);
  return new AiRequestError('ai-request-unconfirmed', provider, status);
}

export function throwAiError(provider: string, error: unknown): never {
  const safe = normalizeAiError(provider, error);
  console.error(`${provider} provider request failed`, { reason: safe.reason, status: safe.status, retryable: safe.retryable });
  throw safe;
}
