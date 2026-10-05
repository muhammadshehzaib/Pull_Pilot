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
 * Hours a cached repository file is kept before automatic deletion.
 * Set NEXT_PUBLIC_CODE_RETENTION_HOURS to match the backend value.
 */
export const CODE_RETENTION_HOURS = parseInt(
  process.env.NEXT_PUBLIC_CODE_RETENTION_HOURS || '24',
  10,
);

/** Human phrasing for the window, e.g. "24 hours" or "7 days". */
export function retentionWindow(): string {
  if (CODE_RETENTION_HOURS % 24 === 0) {
    const days = CODE_RETENTION_HOURS / 24;
    return days === 1 ? '24 hours' : `${days} days`;
  }
  return `${CODE_RETENTION_HOURS} hours`;
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
  return `Repository files used to give the AI surrounding context are encrypted at rest with AES-256-GCM and deleted automatically within ${retentionWindow()}.`;
}

/** Full FAQ answer. States both halves: we do store, and we never train. */
export function codeRetentionFaq(): string {
  return (
    `We do store parts of your repository so the AI can read the code around your changes, ` +
    `which is what lets it catch problems the diff alone cannot show. ` +
    `That code is encrypted at rest with AES-256-GCM and deleted automatically within ${retentionWindow()}. ` +
    `Your code is never used to train, fine-tune, or improve any AI model.`
  );
}