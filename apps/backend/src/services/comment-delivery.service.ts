import { createHash, randomUUID } from 'node:crypto';
import type { CommentDelivery, Prisma, ReviewDeliveryPlan } from '@prisma/client';
import prisma from '../config/prisma';
import { EncryptionService } from './encryption.service';
import { findingIdentity, snapshotIdentity } from './historical/occurrence.service';
import { lockHistoricalRepository, historyCutoff } from './historical/state';
import { renderFindingListItem, renderInlineComment } from './ai/finding-format';
import { normalizeStoredSuggestions, type AiSuggestion } from './ai/finding-taxonomy';
import type { GitHubService } from './github.service';
import { commentDeliveryReport, DELIVERY_TERMINAL_STATES, needsLocationSummary } from './comment-delivery-report';
import { bindFindingAnchors } from './ai/review-anchors';

// The artifact contains existing versioned review metadata in addition to findings.
export type FrozenReview = Record<string, any> & { suggestions: AiSuggestion[] };
type Plan = ReviewDeliveryPlan & { deliveries: CommentDelivery[] };
const eligible = ['QUEUED', 'FETCHING', 'ANALYZING', 'GENERATING', 'POSTING', 'RUNNING', 'RETRYING'];
const terminal = (state: string) => (DELIVERY_TERMINAL_STATES as readonly string[]).includes(state);
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export const deliveryMarker = (id: string) => `<!-- aipr-delivery:v1:${id} -->`;
const LEASE_MS = 30_000;
const COMMENT_RENDERING_VERSION = 2;

export class DeliveryPendingError extends Error {
  constructor(message = 'Comment delivery is unconfirmed or pending', public readonly retryAt?: number) { super(message); }
}

function pendingError(rows: CommentDelivery[]) {
  const leases = rows.filter(r => r.state === 'SENDING' && r.claimExpiresAt).map(r => r.claimExpiresAt!.getTime());
  return new DeliveryPendingError(undefined, leases.length ? Math.min(...leases) : undefined);
}

async function open(row: { encryptedData: string | null; iv: string | null; authTag: string | null; salt: string | null }) {
  if (!row.encryptedData || !row.iv || !row.authTag || !row.salt) throw new Error('Review delivery payload unavailable');
  return await EncryptionService.decrypt(row.encryptedData, row.iv, row.authTag, row.salt);
}
async function payload(id: string, body: string) {
  const text = `${body}\n\n${deliveryMarker(id)}`;
  return { ...await EncryptionService.encrypt(text), payloadHash: digest(text) };
}

function summaryBody(artifact: FrozenReview, rows: CommentDelivery[]): string {
  const rejected = new Set(rows.filter(r => r.kind === 'INLINE' && r.state === 'REJECTED').map(r => r.findingKey));
  const fallback = artifact.suggestions.filter(f => rejected.has(findingIdentity(f)));
  const unverified = new Set(rows.filter(r => r.kind === 'INLINE' && r.reason === 'location-unverified').map(r => r.findingKey));
  const uncertain = artifact.suggestions.filter(f => unverified.has(findingIdentity(f)));
  const report = commentDeliveryReport(rows);
  return [artifact.summaryBase, `- **Comments Posted Inline**: ${report.delivered}/${report.expected}`,
    report.omitted ? `- **Comments omitted inline**: ${report.omitted}` : '',
    fallback.length ? '\n## Findings that could not be attached inline\n\n' + fallback.map(renderFindingListItem).join('\n') : '',
    uncertain.length ? '\n## Findings without a verified code location\n\nThe reported file and line below could not be confirmed. These findings were not attached inline.\n\n' + uncertain.map(renderFindingListItem).join('\n') : '',
  ].filter(Boolean).join('\n');
}

async function lockedJob(tx: Prisma.TransactionClient, jobId: string, repositoryId: string) {
  await lockHistoricalRepository(tx, repositoryId);
  await tx.$queryRaw`SELECT id FROM analysis_jobs WHERE id = ${jobId} FOR UPDATE`;
  const job = await tx.analysisJob.findUnique({ where: { id: jobId }, include: { repository: true } });
  if (!job || job.repositoryId !== repositoryId || !job.repository.isActive || !eligible.includes(job.status)) {
    throw new Error('Review delivery stopped: review or repository is unavailable');
  }
  return job;
}

export async function loadReviewDelivery(jobId: string): Promise<Plan | null> {
  return prisma.reviewDeliveryPlan.findUnique({ where: { analysisJobId: jobId }, include: { deliveries: { orderBy: { deliveryKey: 'asc' } } } });
}

export async function prepareReviewDelivery(input: {
  jobId: string; repositoryId: string; userId: string; headSha: string; baseSha: string;
  fullName: string; prNumber: number; expectedAuthorId: string; artifact: FrozenReview; summaryBase: string; reviewedDiff?: string;
}): Promise<Plan> {
  if (!/^\d+$/.test(input.expectedAuthorId) || !Number.isSafeInteger(input.prNumber) || input.prNumber <= 0) throw new Error('Invalid review delivery destination');
  // Freeze the same trusted representation that completion publishes. Scanner
  // ruleKey aliases and other cleanup must happen before any identity is saved.
  const bound = bindFindingAnchors(normalizeStoredSuggestions(input.artifact.suggestions), input.reviewedDiff ?? '');
  const suggestions = [...new Map(bound.map(f => [findingIdentity(f), f])).values()];
  const artifact: FrozenReview = { ...input.artifact, suggestions, summaryBase: input.summaryBase,
    commentLocationVersion: 1, commentRenderingVersion: COMMENT_RENDERING_VERSION };
  const sealed = await EncryptionService.encrypt(JSON.stringify(artifact));
  const rows: Prisma.CommentDeliveryUncheckedCreateWithoutPlanInput[] = [];
  for (const f of suggestions) {
    const id = randomUUID(), findingKey = findingIdentity(f);
    rows.push({ id, repositoryId: input.repositoryId, deliveryKey: `inline:v1:${findingKey}`, findingKey,
      kind: 'INLINE' as const, state: f.verifiedAnchor ? 'READY' as const : 'OMITTED' as const,
      reason: f.verifiedAnchor ? null : 'location-unverified', path: f.filePath, line: f.lineNumber,
      ...(f.verifiedAnchor ? await payload(id, renderInlineComment(f)) : {}) });
  }
  return prisma.$transaction(async tx => {
    const job = await lockedJob(tx, input.jobId, input.repositoryId);
    if (job.repository.userId !== input.userId || job.eventType !== 'PULL_REQUEST' || job.referenceId !== String(input.prNumber) ||
        job.repository.fullName !== input.fullName || (job.commitSha && job.commitSha !== input.headSha) || job.deliveryVersion !== 1) {
      throw new Error('Review delivery identity mismatch');
    }
    const existing = await tx.reviewDeliveryPlan.findUnique({ where: { analysisJobId: input.jobId }, include: { deliveries: true } });
    if (existing) return existing;
    const plan = await tx.reviewDeliveryPlan.create({ data: {
      analysisJobId: input.jobId, artifactHash: snapshotIdentity(suggestions), headSha: input.headSha, baseSha: input.baseSha,
      fullName: input.fullName, prNumber: input.prNumber, expectedAuthorId: input.expectedAuthorId, ...sealed,
      deliveries: { create: [...rows, ...((artifact.config?.summarize || rows.some(r => r.reason === 'location-unverified')) ? [{ id: randomUUID(), repositoryId: input.repositoryId,
        deliveryKey: 'summary', kind: 'SUMMARY' as const, state: 'WAITING' as const }] : [])] },
    }, include: { deliveries: true } });
    const { summaryBase: _summaryBase, ...results } = artifact;
    await tx.analysisJob.update({ where: { id: input.jobId }, data: { status: 'POSTING', results: JSON.parse(JSON.stringify(results)) } });
    return plan;
  }, { timeout: 15000 });
}

/** This action only reads GitHub. Even a complete empty listing never authorizes another POST. */
export async function reconcileReviewDelivery(plan: Plan, gh: GitHubService, signal?: AbortSignal) {
  const [owner, repo] = plan.fullName.split('/');
  await prisma.commentDelivery.updateMany({ where: { planId: plan.id, state: 'SENDING', claimExpiresAt: { lte: new Date() } },
    data: { state: 'UNKNOWN', reason: 'delivery-unconfirmed' } });
  const rows = await prisma.commentDelivery.findMany({ where: { planId: plan.id, state: 'UNKNOWN' } });
  for (const kind of ['INLINE', 'SUMMARY'] as const) {
    const pending = rows.filter(r => r.kind === kind);
    if (!pending.length || signal?.aborted) continue;
    const listing = await gh.listDeliveryComments(owner, repo, plan.prNumber, kind, signal);
    for (const row of pending) {
      const matches = listing.comments.filter(c => c.authorId === plan.expectedAuthorId && c.body.includes(deliveryMarker(row.id)) &&
        (kind !== 'INLINE' || (c.path === row.path && c.originalCommitId === plan.headSha)));
      if (matches.length === 1) {
        const c = matches[0];
        await prisma.commentDelivery.updateMany({ where: { id: row.id, state: 'UNKNOWN', payloadHash: row.payloadHash },
          data: { state: 'DELIVERED', githubCommentId: c.id, githubUrl: c.url, reason: null } });
      } else {
        await prisma.commentDelivery.updateMany({ where: { id: row.id, state: 'UNKNOWN' }, data: {
          reason: matches.length > 1 ? 'multiple-comment-matches' : listing.complete ? 'delivery-unconfirmed' : 'reconciliation-incomplete',
        } });
      }
    }
  }
}

export async function deliverReviewPlan(plan: Plan, gh?: GitHubService, signal?: AbortSignal) {
  const artifact = JSON.parse(await open(plan)) as FrozenReview;
  const finish = (rows: CommentDelivery[]) => {
    const { summaryBase: _summary, ...completion } = artifact;
    return { artifact: { ...completion, commentDelivery: commentDeliveryReport(rows),
      commentFailures: rows.filter(r => r.state === 'REJECTED' || r.state === 'OMITTED').map(r => `${r.path ?? 'summary'}: ${r.reason}`),
      summaryPosted: !rows.some(r => r.kind === 'SUMMARY') || rows.some(r => r.kind === 'SUMMARY' && r.state === 'DELIVERED') } as FrozenReview };
  };
  const savedRows = await prisma.commentDelivery.findMany({ where: { planId: plan.id } });
  if (savedRows.every(r => terminal(r.state)) && !needsLocationSummary(savedRows)) return finish(savedRows);
  if (!gh) throw new Error('GitHub connector required for pending delivery');
  const job = await prisma.analysisJob.findUniqueOrThrow({ where: { id: plan.analysisJobId } });
  const repositoryId = job.repositoryId;
  const [owner, repo] = plan.fullName.split('/');
  await reconcileReviewDelivery(plan, gh, signal);
  if (await gh.getPostingAuthorId(signal) !== plan.expectedAuthorId) throw new Error('GitHub posting identity changed');
  // Do not attach old findings to a newer diff. Already accepted requests remain evidence.
  const current = await gh.getPullRequest(owner, repo, plan.prNumber, signal);
  if (current.head.sha !== plan.headSha) {
    await prisma.commentDelivery.updateMany({ where: { planId: plan.id, state: { in: ['READY', 'WAITING'] } },
      data: { state: 'OMITTED', reason: 'pr-head-changed' } });
  }

  const send = async (row: CommentDelivery) => {
    if (signal?.aborted) throw new Error('Review delivery aborted');
    if (row.state !== 'READY') return;
    if (row.kind === 'INLINE') {
      const finding = artifact.suggestions.find(f => findingIdentity(f) === row.findingKey);
      if (artifact.commentLocationVersion !== 1 || !finding?.verifiedAnchor ||
          finding.filePath !== row.path || finding.lineNumber !== row.line) {
        await prisma.$transaction(async tx => {
          await lockedJob(tx, plan.analysisJobId, repositoryId);
          await tx.commentDelivery.updateMany({ where: { id: row.id, state: 'READY' },
            data: { state: 'OMITTED', reason: 'location-unverified' } });
        });
        return;
      }
    }
    if (row.nextAttemptAt && row.nextAttemptAt.getTime() > Date.now()) throw new DeliveryPendingError('GitHub requested delivery backoff', row.nextAttemptAt.getTime());
    if (artifact.commentRenderingVersion !== COMMENT_RENDERING_VERSION) {
      // Upgrade only definitely-unsent bytes, before acquiring a send claim.
      // Frozen findings and receipts stay immutable. A lost CAS means another
      // worker claimed/changed the row; it must never authorize a new POST.
      const previous = await open(row);
      if (digest(previous) !== row.payloadHash) throw new Error('Review delivery payload changed');
      const finding = artifact.suggestions.find(f => findingIdentity(f) === row.findingKey);
      const body = row.kind === 'INLINE' ? renderInlineComment(finding!)
        : summaryBody(artifact, await prisma.commentDelivery.findMany({ where: { planId: plan.id } }));
      const text = `${body}\n\n${deliveryMarker(row.id)}`;
      if (digest(text) !== row.payloadHash) {
        const replacement = { ...await EncryptionService.encrypt(text), payloadHash: digest(text) };
        const upgraded = await prisma.$transaction(async tx => {
          await lockedJob(tx, plan.analysisJobId, repositoryId);
          return tx.commentDelivery.updateMany({ where: { id: row.id, state: 'READY', payloadHash: row.payloadHash }, data: replacement });
        });
        if (!upgraded.count) return;
        row = { ...row, ...replacement };
      }
    }
    const claimToken = randomUUID();
    const claimed = await prisma.$transaction(async tx => {
      await lockedJob(tx, plan.analysisJobId, repositoryId);
      return tx.commentDelivery.updateMany({ where: { id: row.id, state: 'READY', payloadHash: row.payloadHash },
        data: { state: 'SENDING', claimToken, claimExpiresAt: new Date(Date.now() + LEASE_MS), attempts: { increment: 1 } } });
    });
    if (!claimed.count) return;
    const allowed = await prisma.$transaction(async tx => {
      await lockedJob(tx, plan.analysisJobId, repositoryId);
      return tx.commentDelivery.findFirst({ where: { id: row.id, state: 'SENDING', claimToken, claimExpiresAt: { gt: new Date() } } });
    });
    if (!allowed || signal?.aborted) return;
    const body = await open(row);
    if (digest(body) !== row.payloadHash) throw new Error('Review delivery payload changed');
    // Do not race receipt persistence against cancellation: an accepted request can finish late.
    let result;
    try {
      result = row.kind === 'INLINE'
        ? await gh.createReviewComment(owner, repo, plan.prNumber, plan.headSha, row.path!, row.line!, body, signal)
        : await gh.createIssueComment(owner, repo, plan.prNumber, body, signal);
    } catch { result = { ok: false, failure: 'UNKNOWN' as const }; }
    const where = { id: row.id, claimToken, payloadHash: row.payloadHash, state: { in: ['SENDING', 'UNKNOWN'] as ('SENDING' | 'UNKNOWN')[] } };
    if (result?.ok && result.id && /^\d+$/.test(result.id)) {
      await prisma.commentDelivery.updateMany({ where, data: { state: 'DELIVERED', githubCommentId: result.id, githubUrl: result.url, reason: null } });
    } else if (result?.failure === 'REJECTED') {
      await prisma.commentDelivery.updateMany({ where, data: { state: 'REJECTED', reason: result.error ?? 'github-rejected' } });
    } else if (result?.failure === 'RETRYABLE') {
      await prisma.commentDelivery.updateMany({ where, data: { state: 'READY', reason: 'github-rate-limited', nextAttemptAt: new Date(result.retryAt ?? Date.now() + 60_000), claimToken: null, claimExpiresAt: null } });
      throw new DeliveryPendingError('GitHub requested delivery backoff', result.retryAt);
    } else {
      await prisma.commentDelivery.updateMany({ where, data: { state: 'UNKNOWN', reason: 'delivery-unconfirmed' } });
    }
  };

  let rows = await prisma.commentDelivery.findMany({ where: { planId: plan.id }, orderBy: { deliveryKey: 'asc' } });
  const order = new Map(artifact.suggestions.map((f, i) => [findingIdentity(f), i]));
  for (const row of rows.filter(r => r.kind === 'INLINE').sort((a, b) => (order.get(a.findingKey!) ?? 0) - (order.get(b.findingKey!) ?? 0))) await send(row);
  rows = await prisma.commentDelivery.findMany({ where: { planId: plan.id } });
  if (rows.some(r => r.kind === 'INLINE' && !terminal(r.state))) {
    throw pendingError(rows);
  }
  if (needsLocationSummary(rows)) {
    // Older plans may have disabled summaries. Add one tracked fallback slot
    // under the job lock; never replace or repeat an existing summary receipt.
    await prisma.$transaction(async tx => {
      await lockedJob(tx, plan.analysisJobId, repositoryId);
      if (!await tx.commentDelivery.findFirst({ where: { planId: plan.id, kind: 'SUMMARY' } })) {
        await tx.commentDelivery.create({ data: { id: randomUUID(), planId: plan.id, repositoryId,
          deliveryKey: 'summary', kind: 'SUMMARY', state: 'WAITING' } });
      }
    });
    rows = await prisma.commentDelivery.findMany({ where: { planId: plan.id } });
  }
  const summary = rows.find(r => r.kind === 'SUMMARY');
  if (summary?.state === 'WAITING') {
    const body = summaryBody(artifact, rows);
    await prisma.$transaction(async tx => {
      await lockedJob(tx, plan.analysisJobId, repositoryId);
      await tx.commentDelivery.updateMany({ where: { id: summary.id, state: 'WAITING' }, data: { state: 'READY', ...await payload(summary.id, body) } });
    });
  }
  if (summary) await send(await prisma.commentDelivery.findUniqueOrThrow({ where: { id: summary.id } }));
  rows = await prisma.commentDelivery.findMany({ where: { planId: plan.id } });
  if (rows.some(r => !terminal(r.state))) throw pendingError(rows);
  return finish(rows);
}

export async function purgeRepositoryDeliveryPayloads(repositoryId: string) {
  const empty = { encryptedData: null, iv: null, authTag: null, salt: null };
  await prisma.$transaction(async tx => {
    await lockHistoricalRepository(tx, repositoryId);
    // This is an explicit disconnect action. A quick reconnect must not revive
    // old workers holding source payloads in memory or reset an uncertain send.
    const scope = { plan: { analysisJob: { repositoryId } } };
    await tx.commentDelivery.updateMany({ where: { ...scope, state: { in: ['READY', 'WAITING'] } },
      data: { state: 'OMITTED', reason: 'repository-disconnected' } });
    await tx.commentDelivery.updateMany({ where: { ...scope, state: 'SENDING' },
      data: { state: 'UNKNOWN', reason: 'repository-disconnected' } });
    await tx.commentDelivery.updateMany({ where: { plan: { analysisJob: { repositoryId } } }, data: empty });
    await tx.reviewDeliveryPlan.updateMany({ where: { analysisJob: { repositoryId } }, data: empty });
  });
}

/** Keep receipts for deduplication, but expire the extra encrypted delivery copy. */
export async function purgeExpiredDeliveryPayloads() {
  const plans = await prisma.reviewDeliveryPlan.findMany({ where: { encryptedData: { not: null },
    OR: [{ analysisJob: { repository: { isActive: false } } },
      { createdAt: { lt: historyCutoff() }, analysisJob: { status: { in: ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT', 'SKIPPED'] } } }] },
    select: { id: true }, orderBy: { createdAt: 'asc' }, take: 500 });
  if (!plans.length) return 0;
  const ids = plans.map(p => p.id), empty = { encryptedData: null, iv: null, authTag: null, salt: null };
  await prisma.$transaction(async tx => {
    await tx.commentDelivery.updateMany({ where: { planId: { in: ids } }, data: empty });
    await tx.reviewDeliveryPlan.updateMany({ where: { id: { in: ids } }, data: empty });
  });
  return plans.length;
}
