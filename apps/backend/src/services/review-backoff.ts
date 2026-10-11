/** Preserve normal exponential retries while honoring GitHub's retry time. */
export function reviewBackoff(attemptsMade: number, _type?: string, error?: Error) {
  const retryAt = (error as (Error & { retryAt?: number }) | undefined)?.retryAt;
  return Math.max(1000 * 2 ** Math.max(0, attemptsMade - 1), typeof retryAt === 'number' && Number.isFinite(retryAt) ? retryAt - Date.now() : 0);
}
