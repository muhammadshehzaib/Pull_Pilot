/** Counts reported by the provider, never estimates based on character lengths. */
export interface AiUsage {
  provider: 'OPENAI' | 'GEMINI' | 'CLAUDE' | 'GROK';
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  /** Claude cache-creation tokens need separate pricing; never price them as ordinary input. */
  cacheWriteTokens: number | null;
}

export type UsageObserver = (usage: AiUsage) => void;

export function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function observeUsage(observer: UsageObserver | undefined, usage: AiUsage): void {
  // Observability must not turn a completed paid request into a failed/retried review.
  try { observer?.(usage); } catch { /* observer failure is not a provider failure */ }
}
