/**
 * Single source of truth for how PullPilot describes its handling of
 * customer source code.
 *
 * These claims are published in the footer, the feature grid, the FAQ, the
 * comparison table, the page metadata and the privacy policy. They were
 * duplicated across all of those, which is how "zero code retention" ended up
 * asserted in eight places — and how one of them could quietly become false.
 *
 * If the retention behaviour changes, change it here. The number below must
 * match CONTEXT_RETENTION_HOURS in the backend, because the privacy policy
 * states it as a factual promise rather than an aspiration.
 */

/**
 * Single source of truth for how PullPilot describes its handling of
 * customer source code.
 *
 * These claims are published in the footer, the feature grid, the FAQ, the
 * comparison table, the page metadata and the privacy policy. They were
 * duplicated across all of those, which is how "zero code retention" ended up
 * asserted in eight places — and how one of them could quietly become false.
 *
 * If the retention behaviour changes, change it here. The value below must
 * match CONTEXT_RETENTION_HOURS in the backend, because the privacy policy
 * states it as a factual promise rather than an aspiration.
 */

/**
 * Hours a cached repository file is kept before automatic deletion.
 * Zero means it is kept until the repository is disconnected.
 * Set NEXT_PUBLIC_CODE_RETENTION_HOURS to match the backend value.
 */
const parsedRetention = parseInt(process.env.NEXT_PUBLIC_CODE_RETENTION_HOURS || '0', 10);
export const CODE_RETENTION_HOURS = Number.isFinite(parsedRetention) ? parsedRetention : 24;

/** True when cached code lives until its repository is disconnected. */
export const CODE_RETAIN_INDEFINITELY = CODE_RETENTION_HOURS <= 0;

/** A short duration, e.g. "24 hours" or "7 days". Null when indefinite. */
export function retentionWindow(): string | null {
  if (CODE_RETAIN_INDEFINITELY) return null;
  if (CODE_RETENTION_HOURS % 24 === 0) {
    const days = CODE_RETENTION_HOURS / 24;
    return days === 1 ? '24 hours' : `${days} days`;
  }
  return `${CODE_RETENTION_HOURS} hours`;
}

/**
 * One sentence stating how long cached code lives, for use in body copy.
 *
 * Kept separate from retentionWindow() because the two modes need different
 * grammar: a duration slots into "deleted within ___", while "kept until
 * disconnected" is a clause of its own.
 */
export function retentionPolicySentence(): string {
  if (CODE_RETAIN_INDEFINITELY) {
    return 'It is kept for as long as your repository stays connected to PullPilot, and is deleted when you disconnect the repository.';
  }
  return `It is deleted automatically within ${retentionWindow()}.`;
}

/** Short badge for the footer and feature grid. */
export const CODE_HANDLING_BADGE = 'No Training On Your Code';

/**
 * The claim that actually differentiates: true regardless of how long files
 * are cached, and the one worth leading with.
 */
export const NO_TRAINING_CLAIM =
  'Your code is never used to train, fine-tune, or improve any AI model.';

/** Describes what is stored, encrypted how, and deleted when. */
export function codeHandlingSummary(): string {
  return (
    `Repository files used to give the AI surrounding context are encrypted at rest with AES-256-GCM. ` +
    retentionPolicySentence()
  );
}

/** Full FAQ answer. States both halves: we do store, and we never train. */
export function codeRetentionFaq(): string {
  return (
    `We do store parts of your repository so the AI can read the code around your changes, ` +
    `which is what lets it catch problems the diff alone cannot show. ` +
    `That code is encrypted at rest with AES-256-GCM. ${retentionPolicySentence()} ` +
    `Your code is never used to train, fine-tune, or improve any AI model.`
  );
}