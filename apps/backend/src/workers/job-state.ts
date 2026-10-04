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
 * States a review cannot leave. Anything still running once one of these is
 * persisted must stop touching the PR.
 */
export const TERMINAL_REVIEW_STATUSES = [
  'COMPLETED',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
  'TIMEOUT',
] as const;

/**
 * Terminal states that mean "a human or a clock stopped this", as opposed to
 * states that mean the work finished or failed on its own.
 *
 * These are the two the pipeline must be able to notice mid-flight. A worker
 * cannot be interrupted while it is blocked on a promise — a cancelled review
 * whose model call is still outstanding would otherwise carry on and post
 * comments onto a PR the user cancelled. So the pipeline re-checks at each step
 * boundary and abandons the attempt when it sees one of these.
 */
export const SUPERSEDED_REVIEW_STATUSES = ['CANCELLED', 'TIMEOUT'] as const;

export function isTerminalStatus(value: unknown): boolean {
  return typeof value === 'string' && (TERMINAL_REVIEW_STATUSES as readonly string[]).includes(value);
}

/**
 * States where a review is still doing (or about to do) work, and is therefore
 * the only set for which cancelling is meaningful.
 */
const IN_PROGRESS_REVIEW_STATUSES: readonly string[] = [
  'QUEUED',
  'FETCHING',
  'ANALYZING',
  'GENERATING',
  'POSTING',
  'RUNNING',
];

export function isInProgressStatus(value: unknown): boolean {
  return typeof value === 'string' && IN_PROGRESS_REVIEW_STATUSES.includes(value);
}

export function isSupersededStatus(value: unknown): boolean {
  return typeof value === 'string' && (SUPERSEDED_REVIEW_STATUSES as readonly string[]).includes(value);
}

async function readStatus(jobId: string): Promise<string | undefined> {
  const row = await prisma.analysisJob.findUnique({
    where: { id: jobId },
    select: { status: true },
  });
  return row?.status;
}

/**
 * True when this review was cancelled or timed out after the current attempt
 * started. Read at step boundaries rather than continuously: it is a database
 * round trip, and the alternative — polling during a long model call — buys
 * nothing, since the model call cannot be interrupted either way.
 */
export async function wasSuperseded(jobId: string): Promise<boolean> {
  return isSupersededStatus(await readStatus(jobId));
}

/**
 * Persists a terminal exit and mirrors it to the dashboard.
 *
 * Terminal writes deliberately skip the monotonic guard used by advanceReview:
 * once a review is cancelled or timed out, a later in-flight write must not be
 * able to resurrect it as COMPLETED.
 */
export async function markReviewTerminal(
  jobId: string,
  userId: string,
  status: 'COMPLETED' | 'FAILED' | 'SKIPPED' | 'CANCELLED' | 'TIMEOUT',
  message: string,
  results?: Record<string, unknown>,
): Promise<void> {
  await prisma.analysisJob.update({
    where: { id: jobId },
    data: {
      status,
      ...(results ? { results: results as never } : {}),
    },
  });

  SocketService.emitStatus(userId, jobId, message, status);
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
