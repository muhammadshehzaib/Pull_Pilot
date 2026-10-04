import prisma from '../config/prisma';
import { SocketService } from '../config/socket';

/**
 * Review lifecycle, as a set of states rather than a single RUNNING flag.
 *
 * The pipeline is:
 *
 *   QUEUED -> FETCHING -> ANALYZING -> GENERATING -> POSTING -> COMPLETED
 *
 * with FAILED / SKIPPED / CANCELLED / TIMEOUT as terminal exits. Persisting
 * each transition (rather than only the start and end) is what lets the
 * dashboard answer "where is my review right now" and lets job-retention tell
 * a stuck review from one that never ran.
 */
export const REVIEW_PHASES = [
  'FETCHING',
  'ANALYZING',
  'GENERATING',
  'POSTING',
] as const;
export type ReviewPhase = (typeof REVIEW_PHASES)[number];

/**
 * A phase may only move forward, or into a terminal state. Retries re-enter the
 * pipeline at FETCHING because that is where a BullMQ attempt restarts.
 */
const PHASE_RANK: Record<ReviewPhase, number> = {
  FETCHING: 0,
  ANALYZING: 1,
  GENERATING: 2,
  POSTING: 3,
};

export function isReviewPhase(value: unknown): value is ReviewPhase {
  return typeof value === 'string' && (REVIEW_PHASES as readonly string[]).includes(value);
}

/**
 * Records a phase transition and mirrors it to the dashboard in one call.
 *
 * Going backwards is a no-op rather than an error: BullMQ retries re-enter at
 * FETCHING, and a late write from an earlier step must not make a review that
 * is already posting look like it is still analysing.
 */
export async function advanceReview(
  jobId: string,
  userId: string,
  phase: ReviewPhase,
  message: string,
): Promise<void> {
  const current = await prisma.analysisJob.findUnique({
    where: { id: jobId },
    select: { status: true },
  });

  if (current && isReviewPhase(current.status)) {
    if (PHASE_RANK[phase] <= PHASE_RANK[current.status]) {
      return;
    }
  }

  await prisma.analysisJob.update({
    where: { id: jobId },
    data: { status: phase },
  });

  SocketService.emitStatus(userId, jobId, message, phase);
}
