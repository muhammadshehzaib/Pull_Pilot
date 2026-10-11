import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { analysisQueue } from '../config/queue';
import { isInProgressStatus, markReviewTerminal } from '../workers/job-state';
import { AiSuggestion, normalizeStoredSuggestions } from '../services/ai/finding-taxonomy';
import { paginationMeta, parsePagination } from '../utils/pagination';
import { behavioralForJob } from '../services/behavioral/behavioral.service';
import { assessExplainableRisk, type ExplainableRiskReport } from '../services/security/risk-engine';
import { findingIdentity } from '../services/historical/occurrence.service';
import { historyCutoff } from '../services/historical/state';
import { mayDeprioritize, ADAPTATION_POLICY } from '../services/feedback-loop/adaptation-policy';
import { commentDeliveryReport } from '../services/comment-delivery-report';
import { loadReviewDelivery, reconcileReviewDelivery } from '../services/comment-delivery.service';
import { GitHubAppService } from '../services/github-app.service';

/**
 * Every value the `JobStatus` enum can hold. Kept as an explicit list because
 * Prisma's generated type is not usable as a runtime guard — the filter is user
 * input arriving as a string.
 *
 * Stays here rather than in utils/constants.ts: this list is the source of the
 * JobStatus type exported below, and it is review-lifecycle vocabulary, which
 * belongs with workers/job-state.ts.
 */
const JOB_STATUSES = [
  'QUEUED',
  'FETCHING',
  'ANALYZING',
  'GENERATING',
  'POSTING',
  'RETRYING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
  'TIMEOUT',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/** Returns the status if it is a real enum value, otherwise undefined. */
export function parseJobStatus(value: unknown): JobStatus | undefined {
  return JOB_STATUSES.includes(value as JobStatus) ? (value as JobStatus) : undefined;
}

export type { AiSuggestion };

export function extractNormalizedFindings(results: unknown): AiSuggestion[] {
  if (!results || typeof results !== 'object') return [];
  if (Array.isArray(results)) {
    return normalizeStoredSuggestions(results);
  }
  const obj = results as Record<string, unknown>;
  if (Array.isArray(obj.suggestions)) {
    return normalizeStoredSuggestions(obj.suggestions);
  }
  return [];
}

export class JobController {
  /**
   * Lists past analysis jobs for the authenticated user's repos.
   *
   * Filters: ?page=, ?limit=, ?repositoryId=, ?referenceId=, ?status=
   *
   * `referenceId` is what makes "every review this PR has had" answerable — it
   * is the PR number for PULL_REQUEST events and the commit SHA for PUSH events,
   * so one PR's full history is a single query instead of paging the global list
   * and hoping the PR's reviews are still in the first 50 rows.
   *
   * Returns lightweight rows (no findings) — use the detail endpoint to fetch the
   * full results JSON. `pagination` carries the count for the current filter set
   * so the UI can render page numbers without a second endpoint.
   */
  static async list(req: Request, res: Response) {
    const { page, limit, skip } = parsePagination(req.query);
    const repositoryId = (req.query.repositoryId as string) || undefined;
    const referenceId = (req.query.referenceId as string) || undefined;
    const status = parseJobStatus(req.query.status as string);

    const where = {
      repository: { userId: req.auth!.userId },
      ...(repositoryId ? { repositoryId } : {}),
      ...(referenceId ? { referenceId } : {}),
      // An unrecognised status is ignored rather than 400'd: the filter is a
      // UI convenience and must never be able to break the list endpoint.
      ...(status ? { status } : {}),
    };

    // The count shares `where` with the page query, so the total always
    // describes the same filtered set the rows come from.
    const [jobs, total] = await Promise.all([
      prisma.analysisJob.findMany({
        where,
        include: {
          repository: { select: { id: true, fullName: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.analysisJob.count({ where }),
    ]);

    return res.json({
      jobs: jobs.map((j) => ({
        id: j.id,
        eventType: j.eventType,
        referenceId: j.referenceId,
        status: j.status,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
        repository: j.repository,
        findingCount: extractNormalizedFindings(j.results).length,
      })),
      pagination: paginationMeta(page, limit, total),
    });
  }

  static async get(req: Request, res: Response) {
    const job = await prisma.analysisJob.findFirst({
      where: {
        id: String(req.params.id),
        repository: { userId: req.auth!.userId },
      },
      include: {
        deliveryPlan: { select: { deliveries: { select: { kind: true, state: true, reason: true, githubUrl: true } } } },
        repository: { select: { id: true, fullName: true } },
        // Per-rule pass/fail records for this job, oldest first. Rows outlive
        // the rule they describe (ruleId goes null, ruleName is snapshotted),
        // so this is the durable enforcement history either way.
        ruleChecks: { orderBy: { createdAt: 'asc' } },
        // Per-probe pass/fail records for the deterministic security layer.
        securityChecks: { orderBy: { createdAt: 'asc' } },
        behavioralRuns: { where: { expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' }, take: 5 },
        findingOccurrences: { where: { superseded: false, findingKey: { not: '' },
          analysisJob: { createdAt: { gte: historyCutoff() } } }, include: { feedback: true, workflow: true } },
      },
    });

    if (!job) return res.status(404).json({ error: 'Job not found' });

    const normalizedFindings = extractNormalizedFindings(job.results);
    const rawObj = (job.results && typeof job.results === 'object' && !Array.isArray(job.results))
      ? (job.results as Record<string, unknown>)
      : {};
    const { behavioralRuns, findingOccurrences, deliveryPlan, ...publicJob } = job;
    const occurrencesByKey = new Map((findingOccurrences ?? []).map(occ => [occ.findingKey, occ]));
    const findingsWithFeedback = normalizedFindings.map(finding => {
      const occurrence = occurrencesByKey.get(findingIdentity(finding));
      return occurrence ? { ...finding, findingId: occurrence.id,
        workflow: occurrence.workflow ? { status: occurrence.workflow.status, revision: occurrence.workflow.revision } : { status: 'OPEN', revision: 0 },
        adaptation: normalizeFindingAdaptation(finding, rawObj.feedbackAdaptation), feedback: occurrence.feedback ? {
        disposition: occurrence.feedback.disposition, rejectionReason: occurrence.feedback.rejectionReason,
        note: occurrence.feedback.note, revision: occurrence.feedback.revision,
      } : { disposition: 'UNREVIEWED', rejectionReason: null, note: null, revision: 0 } } : finding;
    });
    const behavioral = behavioralForJob(rawObj, behavioralRuns);
    const storedRiskV2 = rawObj.riskV2 as ExplainableRiskReport | undefined;
    // Do not retroactively invent scan coverage or upgrade legacy risk reports.
    const riskV2 = storedRiskV2?.version === 2 ? assessExplainableRisk(normalizedFindings, {
      blockOnCriticalSecret: (rawObj.config as any)?.security?.block_on_critical_secret,
      includedFiles: Array.isArray(rawObj.includedFiles) ? rawObj.includedFiles : [],
      ignoredFiles: Array.isArray(rawObj.ignoredFiles) ? rawObj.ignoredFiles : [],
      securityChecks: Array.isArray(rawObj.securityChecks) ? rawObj.securityChecks : job.securityChecks,
      ruleChecks: Array.isArray(rawObj.ruleChecks) ? rawObj.ruleChecks : job.ruleChecks,
      testGaps: rawObj.testGaps as any, behavioral,
      context: storedRiskV2.coverage?.context ?? 'NOT_RUN',
    }) : undefined;

    return res.json({
      job: {
        ...publicJob,
        results: findingsWithFeedback,
        metadata: {
          ignoredFiles: Array.isArray(rawObj.ignoredFiles) ? (rawObj.ignoredFiles as string[]) : [],
          includedFiles: Array.isArray(rawObj.includedFiles) ? (rawObj.includedFiles as string[]) : [],
          // Risk engine output (score / verdict / reasons), rehydrated from the
          // results blob so the history page can render the risk card without
          // re-parsing the whole findings array.
          risk: rawObj.risk,
          riskV2,
          // Best-effort test-gap report (missing test scenarios + discovery
          // evidence), or undefined when the provider did not support it.
          testGaps: rawObj.testGaps,
          contextDiscovery: rawObj.contextDiscovery,
          commentDelivery: deliveryPlan ? commentDeliveryReport(deliveryPlan.deliveries) : undefined,
          behavioral,
          historicalMemory: normalizeHistoricalAttribution(rawObj.historicalMemory),
          historicalFeedbackEligible: job.status === 'COMPLETED' && job.createdAt >= historyCutoff(),
          error: typeof rawObj.error === 'string' ? rawObj.error : undefined,
        },
      },
    });
  }

  /**
   * Cancels an in-flight review.
   *
   * Two things happen, and both are needed:
   *
   *  - The queued job is removed from BullMQ, so a review that has not started
   *    yet never starts.
   *  - CANCELLED is persisted, which is what an already-running worker reads at
   *    its next step boundary and abandons. `queue.remove` cannot stop a job that
   *    already holds its lock, so the status write is the only thing that
   *    actually halts one in flight.
   *
   * Cancelling something already finished is a 409 rather than a silent success:
   * the user pressed cancel on a review that had already posted its comments,
   * and telling them it was cancelled would be a lie.
   */
  static async reconcileComments(req: Request, res: Response) {
    const job = await prisma.analysisJob.findFirst({ where: { id: String(req.params.id), repository: { userId: req.auth!.userId, isActive: true } },
      include: { repository: { include: { installation: true } } } });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const plan = await loadReviewDelivery(job.id);
    if (!plan) return res.status(409).json({ error: 'Comment delivery was not tracked for this review' });
    const signal = AbortSignal.timeout(30_000);
    try {
      const gh = await GitHubAppService.getInstallationService(job.repository.installation?.githubInstallationId?.toString());
      await reconcileReviewDelivery(plan, gh, signal);
      const refreshed = await loadReviewDelivery(job.id);
      return res.json({ commentDelivery: refreshed ? commentDeliveryReport(refreshed.deliveries) : undefined });
    } catch { return res.status(503).json({ error: 'Delivery could not be checked. No comments were posted.' }); }
  }

  static async cancel(req: Request, res: Response) {
    const id = String(req.params.id);

    const job = await prisma.analysisJob.findFirst({
      where: {
        id,
        repository: { userId: req.auth!.userId },
      },
      select: { id: true, status: true, repository: { select: { userId: true } } },
    });

    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (!isInProgressStatus(job.status)) {
      return res.status(409).json({
        error: `Job is already ${parseJobStatus(job.status) ?? job.status} and cannot be cancelled.`,
        status: job.status,
      });
    }

    // Drop it from the queue first: a job still sitting in Redis should never be
    // picked up, even briefly, after the user asked us to stop.
    try {
      const removed = await analysisQueue.remove(id);
      if (!removed) {
        // Not in the queue — either already running, or Redis does not know it.
        // Either way the persisted CANCELLED is what stops a running attempt.
        console.log(`↩️  Job ${id} was not removable from the queue (likely already running); relying on CANCELLED status.`);
      }
    } catch (err) {
      // A Redis hiccup must not strand the review as "running forever" — the
      // status write below still takes effect.
      console.warn(`Could not remove job ${id} from the queue:`, err);
    }

    const cancelled = await markReviewTerminal(
      job.id,
      req.auth!.userId,
      'CANCELLED',
      'Review cancelled. A request already sent to GitHub may still finish.',
      { reason: 'cancelled-by-user' },
    );

    if (!cancelled) return res.status(409).json({ error: 'Review already stopped or completed; cancellation was not applied.' });

    return res.json({ status: 'CANCELLED', id: job.id });
  }
}

/** Stored attribution is not permission to hide protected findings. */
export function normalizeFindingAdaptation(finding: AiSuggestion, raw: unknown) {
  if (!mayDeprioritize(finding) || !raw || typeof raw !== 'object') return undefined;
  const report = raw as { version?: unknown; policyVersion?: unknown; entries?: unknown };
  if (report.version !== 1 || report.policyVersion !== ADAPTATION_POLICY.version || !Array.isArray(report.entries)) return undefined;
  const entry = report.entries.slice(0, 200).find(e => e && typeof e === 'object' && e.findingKey === findingIdentity(finding));
  if (!entry || !['FALSE_POSITIVE', 'INTENDED_BEHAVIOR', 'STYLE_PREFERENCE', 'DUPLICATE', 'OUT_OF_SCOPE'].includes(entry.reason) ||
      !Number.isSafeInteger(entry.reviewedPrs) || entry.reviewedPrs < ADAPTATION_POLICY.minReviewedPrs ||
      !Number.isSafeInteger(entry.rejectedPrs) || entry.rejectedPrs > entry.reviewedPrs ||
      entry.rejectedPrs < ADAPTATION_POLICY.minSameReasonPrs || entry.rejectedPrs / entry.reviewedPrs < ADAPTATION_POLICY.rejectionRatio ||
      typeof entry.expiresAt !== 'string' || !(new Date(entry.expiresAt).getTime() > Date.now())) return undefined;
  return { policyVersion: report.policyVersion, reviewedPrs: entry.reviewedPrs, rejectedPrs: entry.rejectedPrs, reason: entry.reason };
}

export function normalizeHistoricalAttribution(value: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const ids = Array.isArray(raw.suppliedPatternIds) ? raw.suppliedPatternIds
    .filter((id): id is string => typeof id === 'string' && id.length <= 128).slice(0, 5) : [];
  if (!ids.length) return undefined;
  return { version: raw.version === 1 ? 1 : undefined,
    algorithmVersion: typeof raw.algorithmVersion === 'string' ? raw.algorithmVersion.slice(0, 40) : undefined,
    suppliedPatternIds: ids, patternCount: ids.length, truncated: raw.truncated === true };
}
