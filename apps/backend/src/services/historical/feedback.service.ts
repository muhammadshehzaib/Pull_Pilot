/**
 * Feedback service — Phase 8 Historical Intelligence
 *
 * Manages developer feedback on individual finding occurrences:
 *   - Upsert feedback with optimistic concurrency (revision check).
 *   - Append an immutable event record for every state change.
 *   - Idempotent: submitting the same disposition + reason twice is a no-op.
 *   - Reset to UNREVIEWED is supported (pass disposition='UNREVIEWED').
 *
 * Safety invariants:
 *   - Silence is never acceptance: only explicit ACCEPTED disposition counts.
 *   - Tenant isolation: every write is scoped by repository.userId = actorId,
 *     enforced by the caller (controller) before this service is invoked.
 *   - No silent backfills during GET requests; this service is write-only.
 */

import prisma from '../../config/prisma';
import type { FeedbackDisposition, RejectionReason } from '@prisma/client';

export type { FeedbackDisposition, RejectionReason };

export interface UpdateFeedbackInput {
  occurrenceId: string;
  actorId: string;
  disposition: FeedbackDisposition;
  rejectionReason?: RejectionReason;
  /** Optional developer note (max 1000 chars enforced by schema). */
  note?: string;
  /**
   * Expected current revision. If the server revision does not match,
   * a 409 Conflict must be returned to prevent lost updates.
   * Omit (or pass undefined) to skip the concurrency check — useful for
   * initial creation where no prior revision exists.
   */
  expectedRevision?: number;
}

export interface FeedbackResult {
  id: string;
  occurrenceId: string;
  disposition: FeedbackDisposition;
  rejectionReason: RejectionReason | null;
  note: string | null;
  revision: number;
  updatedAt: Date;
}

/** Thrown when the server revision does not match expectedRevision. */
export class FeedbackConflictError extends Error {
  readonly currentRevision: number;
  constructor(currentRevision: number) {
    super(`Feedback conflict: server revision is ${currentRevision}. Fetch and retry.`);
    this.name = 'FeedbackConflictError';
    this.currentRevision = currentRevision;
  }
}

/**
 * Upsert feedback for a finding occurrence.
 *
 * If a FindingFeedback row does not yet exist it is created.
 * If it does exist and expectedRevision is supplied, the revision must match
 * the stored value or a FeedbackConflictError is thrown.
 */
export async function updateFeedback(input: UpdateFeedbackInput): Promise<FeedbackResult> {
  const { occurrenceId, actorId, disposition, rejectionReason, note, expectedRevision } = input;

  // Validate note length (belt-and-suspenders beyond the DB constraint).
  if (note && note.length > 1000) {
    throw new Error('Note exceeds maximum length of 1000 characters.');
  }

  // Reject findings must have a rejection reason.
  if (disposition === 'REJECTED' && !rejectionReason) {
    throw new Error('rejectionReason is required when disposition is REJECTED.');
  }

  // Non-REJECTED dispositions must not carry a rejection reason.
  const effectiveRejectionReason = disposition === 'REJECTED' ? (rejectionReason ?? null) : null;

  return prisma.$transaction(async (tx) => {
    const existing = await tx.findingFeedback.findUnique({
      where: { occurrenceId },
    });

    if (existing) {
      // Concurrency check: caller must supply the revision they last saw.
      if (expectedRevision !== undefined && existing.revision !== expectedRevision) {
        throw new FeedbackConflictError(existing.revision);
      }

      // Idempotency: no-op if nothing changed.
      if (
        existing.disposition === disposition &&
        existing.rejectionReason === (effectiveRejectionReason ?? null) &&
        existing.note === (note ?? null)
      ) {
        return {
          id: existing.id,
          occurrenceId,
          disposition: existing.disposition,
          rejectionReason: existing.rejectionReason,
          note: existing.note,
          revision: existing.revision,
          updatedAt: existing.updatedAt,
        };
      }

      const newRevision = existing.revision + 1;

      const updated = await tx.findingFeedback.update({
        where: { id: existing.id },
        data: {
          actorId,
          disposition,
          rejectionReason: effectiveRejectionReason,
          note: note ?? null,
          revision: newRevision,
        },
      });

      await tx.findingFeedbackEvent.create({
        data: {
          feedbackId: existing.id,
          actorId,
          disposition,
          rejectionReason: effectiveRejectionReason,
          revision: newRevision,
        },
      });

      return {
        id: updated.id,
        occurrenceId,
        disposition: updated.disposition,
        rejectionReason: updated.rejectionReason,
        note: updated.note,
        revision: updated.revision,
        updatedAt: updated.updatedAt,
      };
    }

    // Create new feedback row.
    const created = await tx.findingFeedback.create({
      data: {
        occurrenceId,
        actorId,
        disposition,
        rejectionReason: effectiveRejectionReason,
        note: note ?? null,
        revision: 0,
      },
    });

    await tx.findingFeedbackEvent.create({
      data: {
        feedbackId: created.id,
        actorId,
        disposition,
        rejectionReason: effectiveRejectionReason,
        revision: 0,
      },
    });

    return {
      id: created.id,
      occurrenceId,
      disposition: created.disposition,
      rejectionReason: created.rejectionReason,
      note: created.note,
      revision: created.revision,
      updatedAt: created.updatedAt,
    };
  });
}

/**
 * Get the current feedback state for a list of occurrence IDs.
 * Returns a map of occurrenceId → FeedbackResult (omitted if no feedback yet).
 */
export async function getFeedbackForOccurrences(
  occurrenceIds: string[],
): Promise<Map<string, FeedbackResult>> {
  if (occurrenceIds.length === 0) return new Map();

  const rows = await prisma.findingFeedback.findMany({
    where: { occurrenceId: { in: occurrenceIds } },
  });

  const map = new Map<string, FeedbackResult>();
  for (const row of rows) {
    map.set(row.occurrenceId, {
      id: row.id,
      occurrenceId: row.occurrenceId,
      disposition: row.disposition,
      rejectionReason: row.rejectionReason,
      note: row.note,
      revision: row.revision,
      updatedAt: row.updatedAt,
    });
  }
  return map;
}

export interface FeedbackEventResult {
  id: string;
  feedbackId: string;
  actorId: string;
  disposition: FeedbackDisposition;
  rejectionReason: RejectionReason | null;
  revision: number;
  createdAt: Date;
}

/**
 * Get audit event history for an occurrence.
 * Returns events sorted in reverse-chronological order (newest first).
 */
export async function getFeedbackEvents(occurrenceId: string): Promise<FeedbackEventResult[]> {
  const feedback = await prisma.findingFeedback.findUnique({
    where: { occurrenceId },
    include: {
      events: {
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  if (!feedback) return [];

  return feedback.events.map((evt) => ({
    id: evt.id,
    feedbackId: evt.feedbackId,
    actorId: evt.actorId,
    disposition: evt.disposition,
    rejectionReason: evt.rejectionReason,
    revision: evt.revision,
    createdAt: evt.createdAt,
  }));
}
