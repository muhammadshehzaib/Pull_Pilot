import { Request, Response } from 'express';
import prisma from '../config/prisma';
import {
  updateFeedback as updateFeedbackService,
  getFeedbackEvents as getFeedbackEventsService,
  FeedbackConflictError,
  type FeedbackDisposition,
  type RejectionReason,
} from '../services/historical/feedback.service';
import { getOccurrencesForJob, recordJobFindings } from '../services/historical/occurrence.service';
import { extractNormalizedFindings } from './job.controller';

const VALID_DISPOSITIONS: readonly FeedbackDisposition[] = [
  'UNREVIEWED',
  'ACCEPTED',
  'REJECTED',
  'NEEDS_REVIEW',
] as const;

const VALID_REJECTION_REASONS: readonly RejectionReason[] = [
  'FALSE_POSITIVE',
  'DUPLICATE',
  'INTENDED_BEHAVIOR',
  'OUT_OF_SCOPE',
  'STYLE_PREFERENCE',
  'OTHER',
] as const;

export class FindingController {
  /**
   * GET /api/jobs/:id/findings
   *
   * Lists all stable finding occurrences for a job, including their latest feedback
   * disposition and revision. Scoped to the authenticated repository owner.
   */
  static async listForJob(req: Request, res: Response) {
    const jobId = String(req.params.id);

    const job = await prisma.analysisJob.findFirst({
      where: {
        id: jobId,
        repository: { userId: req.auth!.userId },
      },
      select: {
        id: true,
        repositoryId: true,
        status: true,
        results: true,
      },
    });

    if (!job) {
      return res.status(404).json({ error: 'Job not found or access denied' });
    }

    const occurrences = await getOccurrencesForJob(jobId);

    if (occurrences.length === 0) {
      const normalizedLegacy = extractNormalizedFindings(job.results);
      if (normalizedLegacy.length > 0) {
        return res.json({
          jobId: job.id,
          repositoryId: job.repositoryId,
          isLegacy: true,
          canSupportFeedback: false,
          message:
            'This review was completed prior to Historical Intelligence and has no recorded finding identities.',
          findings: [],
        });
      }
    }

    return res.json({
      jobId: job.id,
      repositoryId: job.repositoryId,
      isLegacy: false,
      canSupportFeedback: true,
      findings: occurrences.map((occ) => ({
        id: occ.id,
        filePath: occ.filePath,
        lineNumber: occ.lineNumber,
        category: occ.category,
        severity: occ.severity,
        source: occ.source,
        sources: occ.sources,
        ruleKeys: occ.ruleKeys,
        summary: occ.summary,
        findingKey: occ.findingKey,
        fingerprint: occ.fingerprint,
        feedback: occ.feedback
          ? {
              id: occ.feedback.id,
              disposition: occ.feedback.disposition,
              rejectionReason: occ.feedback.rejectionReason,
              note: occ.feedback.note,
              revision: occ.feedback.revision,
              updatedAt: occ.feedback.updatedAt,
            }
          : {
              disposition: 'UNREVIEWED' as const,
              rejectionReason: null,
              note: null,
              revision: 0,
              updatedAt: occ.createdAt,
            },
      })),
    });
  }

  /**
   * PUT /api/jobs/:id/findings/:findingId/feedback
   *
   * Upserts developer feedback on a finding occurrence.
   * Supports optimistic concurrency check via expectedRevision.
   */
  static async updateFeedback(req: Request, res: Response) {
    const jobId = String(req.params.id);
    const findingId = String(req.params.findingId);
    const { disposition, rejectionReason, note, expectedRevision } = req.body ?? {};

    if (!disposition || !VALID_DISPOSITIONS.includes(disposition)) {
      return res.status(400).json({
        error: `Invalid disposition. Allowed: ${VALID_DISPOSITIONS.join(', ')}`,
      });
    }

    if (disposition === 'REJECTED') {
      if (!rejectionReason || !VALID_REJECTION_REASONS.includes(rejectionReason)) {
        return res.status(400).json({
          error: `rejectionReason is required for REJECTED disposition. Allowed: ${VALID_REJECTION_REASONS.join(', ')}`,
        });
      }
    } else if (rejectionReason !== undefined && rejectionReason !== null) {
      return res.status(400).json({
        error: 'rejectionReason must not be set when disposition is not REJECTED',
      });
    }

    if (note !== undefined && note !== null) {
      if (typeof note !== 'string') {
        return res.status(400).json({ error: 'note must be a string' });
      }
      if (note.length > 1000) {
        return res.status(400).json({ error: 'note must not exceed 1000 characters' });
      }
    }

    if (expectedRevision === undefined || expectedRevision === null) {
      return res.status(400).json({ error: 'expectedRevision is required' });
    } else {
      if (typeof expectedRevision !== 'number' || expectedRevision < 0 || !Number.isSafeInteger(expectedRevision)) {
        return res.status(400).json({ error: 'expectedRevision must be a non-negative integer' });
      }
    }

    // Verify finding belongs to job AND repository belongs to authenticated user
    const occurrence = await prisma.findingOccurrence.findFirst({
      where: {
        id: findingId,
        analysisJobId: jobId,
        repository: { userId: req.auth!.userId },
      },
    });

    if (!occurrence) {
      return res.status(404).json({ error: 'Finding not found or access denied' });
    }

    if (occurrence.superseded) {
      return res.status(409).json({ error: 'Cannot update feedback on a superseded finding' });
    }

    try {
      const result = await updateFeedbackService({
        occurrenceId: findingId,
        actorId: req.auth!.userId,
        disposition,
        rejectionReason: disposition === 'REJECTED' ? rejectionReason : undefined,
        note: note ?? undefined,
        expectedRevision: expectedRevision ?? undefined,
      });

      return res.json({ feedback: result });
    } catch (err: any) {
      if (err instanceof FeedbackConflictError) {
        return res.status(409).json({
          error: err.message,
          currentRevision: err.currentRevision,
        });
      }
      return res.status(503).json({ error: 'Feedback could not be saved; reload and retry' });
    }
  }

  /**
   * GET /api/jobs/:id/findings/:findingId/feedback/events
   *
   * Audit trail of feedback events for a finding occurrence.
   */
  static async getFeedbackEvents(req: Request, res: Response) {
    const jobId = String(req.params.id);
    const findingId = String(req.params.findingId);

    const occurrence = await prisma.findingOccurrence.findFirst({
      where: {
        id: findingId,
        analysisJobId: jobId,
        repository: { userId: req.auth!.userId },
      },
    });

    if (!occurrence) {
      return res.status(404).json({ error: 'Finding not found or access denied' });
    }

    const events = await getFeedbackEventsService(findingId);
    return res.json({ events });
  }

  /**
   * POST /api/jobs/:id/findings/backfill
   *
   * Explicit, idempotent on-demand backfill for legacy completed reviews.
   */
  static async backfillLegacyFindings(req: Request, res: Response) {
    const jobId = String(req.params.id);

    const job = await prisma.analysisJob.findFirst({
      where: {
        id: jobId,
        repository: { userId: req.auth!.userId },
      },
      select: { id: true, repositoryId: true, results: true, status: true },
    });

    if (!job) {
      return res.status(404).json({ error: 'Job not found or access denied' });
    }

    if (job.status !== 'COMPLETED') {
      return res.status(400).json({ error: 'Only completed jobs can be backfilled' });
    }

    const findings = extractNormalizedFindings(job.results);
    try {
      await recordJobFindings(job.id, job.repositoryId, findings);
    } catch {
      return res.status(409).json({ error: 'Review changed, expired, or repository unavailable; reload before backfilling' });
    }

    return res.json({
      jobId: job.id,
      backfilledCount: findings.length,
    });
  }
}
