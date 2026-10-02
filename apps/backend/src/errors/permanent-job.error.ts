/**
 * Raised when a job cannot succeed no matter how many times it is retried.
 *
 * Retrying is only useful for transient faults (a GitHub outage, a rate limit).
 * When the user has to change something first — no API key saved, a repository
 * no longer reachable — burning the retry budget only delays the same failure.
 *
 * Throwing `UnrecoverableError` tells BullMQ to stop immediately instead of
 * replaying the job.
 */
export class PermanentJobError extends Error {
  /** Machine-readable reason, stored on the job row for the dashboard. */
  public readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'PermanentJobError';
    this.reason = reason;
  }
}

export function isPermanentJobError(err: unknown): err is PermanentJobError {
  return err instanceof PermanentJobError;
}