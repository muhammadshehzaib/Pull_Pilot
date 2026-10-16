import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { GitHubService, DeliveredGitHubComment, CommentPostResult } from './github.service';
import { scanSast } from './security/probes/sast';
import { scanSecrets } from './security/probes/secrets';
import { verifiedLocationFixture } from '../test-utils/comment-locations';

const url = process.env.DELIVERY_TEST_DATABASE_URL;
describe.skipIf(!url)('durable comment delivery on PostgreSQL', () => {
  let db: typeof import('../config/prisma').default;
  let service: typeof import('./comment-delivery.service');
  let record: typeof import('./historical/occurrence.service').recordJobFindings;
  const userId = randomUUID();
  let repositoryId: string;
  const finding = { filePath: 'src/payment.ts', lineNumber: 3, agentType: 'BUG' as const, priority: 'HIGH' as const, issue: 'Webhook can break', suggestion: 'Keep its contract' };
  let nextComment = 1;
  beforeAll(async () => {
    const target = new URL(url!);
    if (!['localhost', '127.0.0.1'].includes(target.hostname) || !target.pathname.endsWith('_test') || process.env.DATABASE_URL !== url) {
      throw new Error('Delivery tests require an explicitly selected local disposable *_test database');
    }
    process.env.ENCRYPTION_KEY ||= 'delivery_integration_only_long_key';
    db = (await import('../config/prisma')).default;
    service = await import('./comment-delivery.service');
    record = (await import('./historical/occurrence.service')).recordJobFindings;
    await db.user.create({ data: { id: userId, githubId: userId, username: 'delivery-test' } });
    repositoryId = (await db.repository.create({ data: { userId, githubRepoId: BigInt(Date.now()), fullName: 'delivery/test' } })).id;
  });
  afterAll(async () => { if (db) { await db.user.delete({ where: { id: userId } }); await db.$disconnect(); } });

  async function input(summarize = false, count = 1) {
    const job = await db.analysisJob.create({ data: { repositoryId, eventType: 'PULL_REQUEST', referenceId: '42' } });
    const { suggestions, reviewedDiff } = verifiedLocationFixture(Array.from({ length: count }, (_, i) => ({ ...finding, lineNumber: 3 + i })));
    return { jobId: job.id, repositoryId, userId, headSha: 'head', baseSha: 'base', fullName: 'delivery/test', prNumber: 42,
      expectedAuthorId: '7', summaryBase: '## Saved review summary', reviewedDiff,
      artifact: { suggestions, config: { summarize }, contextDiscovery: { status: 'PARTIAL' } } };
  }
  function github() {
    const comments: (DeliveredGitHubComment & { kind: string })[] = [];
    const accept = (kind: string, body: string, path?: string): CommentPostResult => {
      const id = String(nextComment++), url = `https://github.com/delivery/test/pull/42#comment-${id}`;
      comments.push({ id, url, body, authorId: '7', path, originalCommitId: 'head', kind });
      return { ok: true, id, url };
    };
    const gh = {
      getPostingAuthorId: vi.fn(async () => '7'), getPullRequest: vi.fn(async () => ({ head: { sha: 'head' } })),
      createReviewComment: vi.fn(async (_o: string, _r: string, _pr: number, _sha: string, path: string, _line: number, body: string) => accept('INLINE', body, path)),
      createIssueComment: vi.fn(async (_o: string, _r: string, _pr: number, body: string) => accept('SUMMARY', body)),
      listDeliveryComments: vi.fn(async (_o: string, _r: string, _pr: number, kind: string) => ({ comments: comments.filter(c => c.kind === kind), complete: true })),
    };
    return { gh, api: gh as unknown as GitHubService, comments, accept };
  }
  async function reload(jobId: string) { return (await service.loadReviewDelivery(jobId))!; }

  async function legacyRenderingPlan() {
    const data = await input();
    const plan = await service.prepareReviewDelivery(data);
    const { EncryptionService } = await import('./encryption.service');
    const frozen = JSON.parse(await EncryptionService.decrypt(plan.encryptedData!, plan.iv!, plan.authTag!, plan.salt!));
    delete frozen.commentRenderingVersion;
    await db.reviewDeliveryPlan.update({ where: { id: plan.id }, data: await EncryptionService.encrypt(JSON.stringify(frozen)) });
    const row = plan.deliveries[0]!;
    const unsafe = `\`\`\`suggestion\nKeep its contract\n\`\`\`\n\n${service.deliveryMarker(row.id)}`;
    await db.commentDelivery.update({ where: { id: row.id }, data: { ...await EncryptionService.encrypt(unsafe),
      payloadHash: createHash('sha256').update(unsafe).digest('hex') } });
    return { data, plan: await reload(data.jobId), row, unsafe };
  }

  it('upgrades a legacy READY payload under concurrent delivery claims without duplicate posts', async () => {
    const { data, plan, row } = await legacyRenderingPlan(), fake = github();
    await Promise.allSettled([service.deliverReviewPlan(plan, fake.api), service.deliverReviewPlan(await reload(data.jobId), fake.api)]);
    const result = await service.deliverReviewPlan(await reload(data.jobId), fake.api);
    expect(fake.gh.createReviewComment).toHaveBeenCalledOnce();
    const posted = fake.comments[0]!.body;
    expect(posted).toContain('Suggested approach (manual review)'); expect(posted).not.toContain('```suggestion');
    expect(posted.endsWith(service.deliveryMarker(row.id))).toBe(true);
    const saved = await reload(data.jobId);
    expect(saved.artifactHash).toBe(plan.artifactHash); expect(saved.encryptedData).toBe(plan.encryptedData);
    expect(saved.deliveries[0]).toMatchObject({ id: row.id, deliveryKey: row.deliveryKey, findingKey: row.findingKey,
      state: 'DELIVERED', payloadHash: createHash('sha256').update(posted).digest('hex') });
    await record(data.jobId, repositoryId, result.artifact.suggestions, result.artifact);
    expect((await db.analysisJob.findUniqueOrThrow({ where: { id: data.jobId } })).status).toBe('COMPLETED');
  });

  it('reconciles a possibly accepted legacy payload without rewriting it or posting again', async () => {
    const { data, plan, row, unsafe } = await legacyRenderingPlan(), fake = github();
    const before = (await reload(data.jobId)).deliveries[0]!;
    await db.commentDelivery.update({ where: { id: row.id }, data: { state: 'UNKNOWN' } });
    fake.accept('INLINE', unsafe, row.path!);
    await service.deliverReviewPlan(plan, fake.api);
    const after = (await reload(data.jobId)).deliveries[0]!;
    expect(after.state).toBe('DELIVERED'); expect(after.payloadHash).toBe(before.payloadHash);
    expect(after.encryptedData).toBe(before.encryptedData); expect(fake.gh.createReviewComment).not.toHaveBeenCalled();
  });

  it('prepares an encrypted immutable plan once under concurrent attempts', async () => {
    const data = await input(true, 2);
    const [a, b] = await Promise.all([service.prepareReviewDelivery(data), service.prepareReviewDelivery(data)]);
    expect(a.id).toBe(b.id); expect(a.deliveries).toHaveLength(3);
    expect(JSON.stringify(a)).not.toContain(finding.issue);
    expect(a.encryptedData).not.toContain('Saved review');
    const changed = await service.prepareReviewDelivery({ ...data, artifact: { suggestions: [], config: { summarize: false } }, summaryBase: 'changed' });
    expect(changed.artifactHash).toBe(a.artifactHash); expect(changed.encryptedData).toBe(a.encryptedData);
  });
  it('a crash before preparation leaves no plan; preparing later is safe', async () => {
    const data = await input();
    await expect(service.prepareReviewDelivery({ ...data, userId: 'other' })).rejects.toThrow();
    expect(await service.loadReviewDelivery(data.jobId)).toBeNull();
    expect((await service.prepareReviewDelivery(data)).deliveries).toHaveLength(1);
  });
  it('resumes a prepared artifact and never sends confirmed comments twice', async () => {
    const data = await input(true, 2), plan = await service.prepareReviewDelivery(data), fake = github();
    await service.deliverReviewPlan(plan, fake.api);
    const again = await service.deliverReviewPlan(await reload(data.jobId), fake.api);
    expect(fake.gh.createReviewComment).toHaveBeenCalledTimes(2); expect(fake.gh.createIssueComment).toHaveBeenCalledOnce();
    expect(again.artifact.contextDiscovery).toEqual({ status: 'PARTIAL' });
    expect(again.artifact.commentDelivery.delivered).toBe(2);
  });
  it('keeps an unverified location in one durable summary even when routine summaries are disabled', async () => {
    const data = await input(false); delete data.artifact.suggestions[0]!.verifiedAnchor;
    const plan = await service.prepareReviewDelivery(data), fake = github();
    expect(plan.deliveries.find(row => row.kind === 'INLINE')).toMatchObject({ state: 'OMITTED', reason: 'location-unverified' });
    const { artifact } = await service.deliverReviewPlan(plan, fake.api);
    await record(data.jobId, repositoryId, artifact.suggestions, artifact);
    await service.deliverReviewPlan(await reload(data.jobId));
    expect(fake.gh.createReviewComment).not.toHaveBeenCalled(); expect(fake.gh.createIssueComment).toHaveBeenCalledOnce();
    expect((await db.analysisJob.findUniqueOrThrow({ where: { id: data.jobId } })).status).toBe('COMPLETED');
    expect(await db.findingOccurrence.count({ where: { analysisJobId: data.jobId } })).toBe(1);
  });
  it('recovers a legacy omission crash with one fallback summary under concurrent retries', async () => {
    const data = await input(false), plan = await service.prepareReviewDelivery(data), fake = github();
    const { EncryptionService } = await import('./encryption.service');
    await db.reviewDeliveryPlan.update({ where: { id: plan.id }, data: await EncryptionService.encrypt(JSON.stringify({ ...data.artifact, summaryBase: data.summaryBase })) });
    await db.commentDelivery.updateMany({ where: { planId: plan.id, kind: 'INLINE' }, data: { state: 'OMITTED', reason: 'location-unverified' } });
    await Promise.allSettled([service.deliverReviewPlan(await reload(data.jobId), fake.api), service.deliverReviewPlan(await reload(data.jobId), fake.api)]);
    const { artifact } = await service.deliverReviewPlan(await reload(data.jobId), fake.api);
    await record(data.jobId, repositoryId, artifact.suggestions, artifact);
    expect((await reload(data.jobId)).deliveries.filter(row => row.kind === 'SUMMARY')).toHaveLength(1);
    expect(fake.gh.createReviewComment).not.toHaveBeenCalled(); expect(fake.gh.createIssueComment).toHaveBeenCalledOnce();
  });
  it('recovers an accepted comment whose HTTP response was lost', async () => {
    const data = await input(false, 2), plan = await service.prepareReviewDelivery(data), fake = github();
    fake.gh.createReviewComment.mockImplementationOnce(async (_o, _r, _pr, _sha, path, _line, body) => { fake.accept('INLINE', body, path); throw new Error('response lost'); });
    expect((await service.deliverReviewPlan(plan, fake.api)).artifact.commentDelivery.unconfirmed).toBe(1);
    const result = await service.deliverReviewPlan(await reload(data.jobId), fake.api);
    expect(fake.comments).toHaveLength(2); expect(fake.gh.createReviewComment).toHaveBeenCalledTimes(2);
    expect(result.artifact.commentDelivery.unconfirmed).toBe(0);
  });
  it('recovers an accepted comment after the receipt write fails', async () => {
    const data = await input(), plan = await service.prepareReviewDelivery(data), fake = github();
    const real = db.commentDelivery.updateMany.bind(db.commentDelivery);
    const spy = vi.spyOn(db.commentDelivery, 'updateMany').mockImplementation(async (args: any) => {
      if (args.data.state === 'DELIVERED') throw new Error('receipt DB unavailable');
      return real(args);
    });
    try { await expect(service.deliverReviewPlan(plan, fake.api)).rejects.toThrow('receipt DB'); }
    finally { spy.mockRestore(); }
    await db.commentDelivery.updateMany({ where: { planId: plan.id, state: 'SENDING' }, data: { claimExpiresAt: new Date(0) } });
    await service.deliverReviewPlan(await reload(data.jobId), fake.api);
    expect(fake.gh.createReviewComment).toHaveBeenCalledOnce();
  });
  it('does not resend an expired claim when the worker may have crashed before HTTP', async () => {
    const data = await input(), plan = await service.prepareReviewDelivery(data), fake = github();
    await db.commentDelivery.updateMany({ where: { planId: plan.id }, data: { state: 'SENDING', claimToken: 'abandoned', claimExpiresAt: new Date(0) } });
    expect((await service.deliverReviewPlan(await reload(data.jobId), fake.api)).artifact.commentDelivery.unconfirmed).toBe(1);
    expect(fake.gh.createReviewComment).not.toHaveBeenCalled();
    expect((await reload(data.jobId)).deliveries[0].state).toBe('UNKNOWN');
  });
  it('only one concurrent claim dispatches and a late response cannot trigger a resend', async () => {
    const data = await input(), plan = await service.prepareReviewDelivery(data), fake = github();
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    const pause = new Promise<void>(r => { release = r; });
    fake.gh.createReviewComment.mockImplementationOnce(async (_o, _r, _pr, _sha, path, _line, body) => { entered(); await pause; return fake.accept('INLINE', body, path); });
    const first = service.deliverReviewPlan(plan, fake.api);
    await started;
    await db.commentDelivery.updateMany({ where: { planId: plan.id }, data: { claimExpiresAt: new Date(0) } });
    expect((await service.deliverReviewPlan(await reload(data.jobId), fake.api)).artifact.commentDelivery.unconfirmed).toBe(1);
    release(); await first;
    expect(fake.gh.createReviewComment).toHaveBeenCalledOnce();
    expect((await reload(data.jobId)).deliveries[0].state).toBe('DELIVERED');
  });
  it('a lost summary response is reconciled without a second summary', async () => {
    const data = await input(true), plan = await service.prepareReviewDelivery(data), fake = github();
    fake.gh.createIssueComment.mockImplementationOnce(async (_o, _r, _pr, body) => { fake.accept('SUMMARY', body); return { ok: false, failure: 'UNKNOWN' }; });
    expect((await service.deliverReviewPlan(plan, fake.api)).artifact.commentDelivery.summary).toBe('UNKNOWN');
    await service.deliverReviewPlan(await reload(data.jobId), fake.api);
    expect(fake.gh.createIssueComment).toHaveBeenCalledOnce(); expect(fake.comments).toHaveLength(2);
  });
  it('definitive inline rejection appears only in the one fallback summary', async () => {
    const data = await input(true, 2), plan = await service.prepareReviewDelivery(data), fake = github();
    fake.gh.createReviewComment.mockResolvedValueOnce({ ok: false, failure: 'REJECTED', error: 'github-validation-rejected' });
    const result = await service.deliverReviewPlan(plan, fake.api);
    expect(result.artifact.commentDelivery.rejected).toBe(1);
    expect(fake.comments.filter(c => c.kind === 'SUMMARY')[0].body).toContain('could not be attached inline');
    await service.deliverReviewPlan(await reload(data.jobId), fake.api);
    expect(fake.gh.createIssueComment).toHaveBeenCalledOnce();
  });
  it('waits for an outstanding summary lease before recovery rather than exhausting retries immediately', async () => {
    const data = await input(true), plan = await service.prepareReviewDelivery(data), fake = github();
    const retryAt = Date.now() + 30_000;
    await db.commentDelivery.updateMany({ where: { planId: plan.id, kind: 'INLINE' }, data: { state: 'DELIVERED' } });
    await db.commentDelivery.updateMany({ where: { planId: plan.id, kind: 'SUMMARY' }, data: { state: 'SENDING', claimExpiresAt: new Date(retryAt) } });
    await expect(service.deliverReviewPlan(await reload(data.jobId), fake.api)).rejects.toMatchObject({ retryAt });
    expect(fake.gh.createIssueComment).not.toHaveBeenCalled();
  });
  it('summary-disabled reviews keep rejected findings without a fallback post', async () => {
    const data = await input(), plan = await service.prepareReviewDelivery(data), fake = github();
    fake.gh.createReviewComment.mockResolvedValueOnce({ ok: false, failure: 'REJECTED', error: 'github-rejected-403' });
    const result = await service.deliverReviewPlan(plan, fake.api);
    expect(result.artifact.suggestions).toHaveLength(1); expect(fake.gh.createIssueComment).not.toHaveBeenCalled();
    expect(result.artifact.commentDelivery.summary).toBe('DISABLED');
  });
  it('an unknown inline send never becomes fallback summary content', async () => {
    const data = await input(true), plan = await service.prepareReviewDelivery(data), fake = github();
    fake.gh.createReviewComment.mockResolvedValue({ ok: false, failure: 'UNKNOWN' });
    expect((await service.deliverReviewPlan(plan, fake.api)).artifact.commentDelivery.unconfirmed).toBe(1);
    expect(fake.gh.createIssueComment).toHaveBeenCalledOnce();
    const body = fake.comments.find(c => c.kind === 'SUMMARY')!.body;
    expect(body).toContain('Comment delivery unconfirmed'); expect(body).not.toContain(finding.issue);
    await service.deliverReviewPlan(await reload(data.jobId), fake.api);
    expect(fake.gh.createReviewComment).toHaveBeenCalledOnce();
  });
  it('honors definite rate-limit rejection backoff before safely retrying', async () => {
    const data = await input(), plan = await service.prepareReviewDelivery(data), fake = github();
    const retryAt = Date.now() + 120_000;
    fake.gh.createReviewComment.mockResolvedValueOnce({ ok: false, failure: 'RETRYABLE', retryAt });
    await expect(service.deliverReviewPlan(plan, fake.api)).rejects.toMatchObject({ retryAt });
    await expect(service.deliverReviewPlan(await reload(data.jobId), fake.api)).rejects.toMatchObject({ retryAt });
    expect(fake.gh.createReviewComment).toHaveBeenCalledOnce();
    await db.commentDelivery.updateMany({ where: { planId: plan.id }, data: { nextAttemptAt: new Date(0) } });
    await service.deliverReviewPlan(await reload(data.jobId), fake.api);
    expect(fake.gh.createReviewComment).toHaveBeenCalledTimes(2);
  });
  it.each(['wrong-author', 'wrong-head', 'removed-marker', 'multiple-matches', 'incomplete-list'])('does not accept unsafe reconciliation: %s', async mode => {
    const data = await input(), plan = await service.prepareReviewDelivery(data), fake = github();
    const row = plan.deliveries[0];
    await db.commentDelivery.update({ where: { id: row.id }, data: { state: 'UNKNOWN' } });
    fake.accept('INLINE', service.deliveryMarker(row.id), row.path!);
    if (mode === 'wrong-author') fake.comments[0].authorId = '8';
    if (mode === 'wrong-head') fake.comments[0].originalCommitId = 'other-head';
    if (mode === 'removed-marker') fake.comments[0].body = 'edited';
    if (mode === 'multiple-matches') fake.accept('INLINE', service.deliveryMarker(row.id), row.path!);
    if (mode === 'incomplete-list') fake.gh.listDeliveryComments.mockResolvedValue({ comments: [], complete: false });
    await service.reconcileReviewDelivery(await reload(data.jobId), fake.api);
    expect((await reload(data.jobId)).deliveries[0].state).toBe('UNKNOWN');
    expect(fake.gh.createReviewComment).not.toHaveBeenCalled();
  });
  it('positive matches on partial lists are usable and confirmed deleted comments stay delivered', async () => {
    const data = await input(), plan = await service.prepareReviewDelivery(data), fake = github(), row = plan.deliveries[0];
    await db.commentDelivery.update({ where: { id: row.id }, data: { state: 'UNKNOWN' } });
    fake.accept('INLINE', service.deliveryMarker(row.id), row.path!);
    fake.gh.listDeliveryComments.mockResolvedValue({ comments: fake.comments, complete: false });
    await service.reconcileReviewDelivery(await reload(data.jobId), fake.api);
    fake.comments.length = 0;
    await service.deliverReviewPlan(await reload(data.jobId), fake.api);
    expect(fake.gh.createReviewComment).not.toHaveBeenCalled();
  });
  it('changed PR heads omit unsent comments instead of attaching them to a newer diff', async () => {
    const data = await input(true), plan = await service.prepareReviewDelivery(data), fake = github();
    fake.gh.getPullRequest.mockResolvedValue({ head: { sha: 'new-head' } });
    const result = await service.deliverReviewPlan(plan, fake.api);
    expect(result.artifact.commentDelivery.omitted).toBe(1);
    expect(fake.gh.createReviewComment).not.toHaveBeenCalled(); expect(fake.gh.createIssueComment).not.toHaveBeenCalled();
  });
  it.each(['CANCELLED', 'TIMEOUT'] as const)('cannot send or complete a %s review', async status => {
    const data = await input(), plan = await service.prepareReviewDelivery(data), fake = github();
    await db.analysisJob.update({ where: { id: data.jobId }, data: { status } });
    await expect(service.deliverReviewPlan(plan, fake.api)).rejects.toThrow('stopped');
    await expect(record(data.jobId, repositoryId, data.artifact.suggestions, data.artifact)).rejects.toThrow('terminal');
    expect(fake.gh.createReviewComment).not.toHaveBeenCalled();
  });
  it('refuses final completion while delivery is unfinished and supports finalization-only recovery', async () => {
    const data = await input(), plan = await service.prepareReviewDelivery(data), fake = github();
    await expect(record(data.jobId, repositoryId, data.artifact.suggestions, data.artifact)).rejects.toThrow('unfinished');
    const result = await service.deliverReviewPlan(plan, fake.api);
    await record(data.jobId, repositoryId, result.artifact.suggestions, result.artifact);
    expect((await db.analysisJob.findUniqueOrThrow({ where: { id: data.jobId } })).status).toBe('COMPLETED');
    expect(fake.gh.createReviewComment).toHaveBeenCalledOnce();
    expect(await db.findingOccurrence.count({ where: { analysisJobId: data.jobId } })).toBe(1);
  });
  it.each(['SAST', 'SECRETS'])('completes a real %s finding, preserves history, and never reposts on finalization retry', async probe => {
    const line = probe === 'SAST' ? 'eval(req.body.code);' : `const TOKEN = "ghp_${'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cD0fG3hJ6'}";`;
    const diff = `diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -0,0 +1 @@\n+${line}\n`;
    const findings = (probe === 'SAST' ? scanSast(diff) : scanSecrets(diff)).findings;
    expect(findings).toHaveLength(1);
    const initial = await input(true);
    const data = { ...initial, reviewedDiff: diff, artifact: { ...initial.artifact, suggestions: findings } };
    const plan = await service.prepareReviewDelivery(data), fake = github();
    const { artifact } = await service.deliverReviewPlan(plan, fake.api);
    await record(data.jobId, repositoryId, artifact.suggestions, artifact);
    expect((await db.analysisJob.findUniqueOrThrow({ where: { id: data.jobId } })).status).toBe('COMPLETED');
    expect(await db.findingOccurrence.findFirst({ where: { analysisJobId: data.jobId } })).toMatchObject({ ruleKeys: [findings[0]!.ruleKey] });
    const resumed = await service.deliverReviewPlan(await reload(data.jobId));
    await record(data.jobId, repositoryId, resumed.artifact.suggestions, resumed.artifact);
    expect(fake.gh.createReviewComment).toHaveBeenCalledOnce();
    expect(fake.gh.createIssueComment).toHaveBeenCalledOnce();
    expect(await db.findingOccurrence.count({ where: { analysisJobId: data.jobId } })).toBe(1);
    await db.analysisJob.update({ where: { id: data.jobId }, data: { updatedAt: new Date(Date.now() - 8 * 86400000) } });
    await (await import('../workers/job-retention')).sweepFailedJobsOnce(7);
    expect((await db.analysisJob.findUniqueOrThrow({ where: { id: data.jobId } })).status).toBe('COMPLETED');
  });
  it('finishes an old raw-hash security plan after delivery without rewriting its hash', async () => {
    const diff = 'diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -0,0 +1 @@\n+eval(req.body.code);\n';
    const findings = scanSast(diff).findings;
    const initial = await input();
    const data = { ...initial, reviewedDiff: diff, artifact: { ...initial.artifact, suggestions: findings } };
    const plan = await service.prepareReviewDelivery(data);
    const { EncryptionService } = await import('./encryption.service');
    const { snapshotIdentity, findingIdentity } = await import('./historical/occurrence.service');
    const originalHash = snapshotIdentity(findings), originalKey = findingIdentity(findings[0]!);
    await db.reviewDeliveryPlan.update({ where: { id: plan.id }, data: { artifactHash: originalHash,
      ...await EncryptionService.encrypt(JSON.stringify({ ...data.artifact, summaryBase: data.summaryBase })) } });
    await db.commentDelivery.update({ where: { id: plan.deliveries[0]!.id }, data: { findingKey: originalKey, deliveryKey: `inline:v1:${originalKey}` } });
    const fake = github(), { artifact } = await service.deliverReviewPlan(await reload(data.jobId), fake.api);
    await record(data.jobId, repositoryId, artifact.suggestions, artifact);
    expect((await db.analysisJob.findUniqueOrThrow({ where: { id: data.jobId } })).status).toBe('COMPLETED');
    expect((await reload(data.jobId)).artifactHash).toBe(originalHash);
    expect(fake.gh.createReviewComment).not.toHaveBeenCalled();
    expect(fake.gh.createIssueComment).toHaveBeenCalledOnce();
  });
  it('preserves findings on failure/cancellation and blocks completion races', async () => {
    const data = await input(), plan = await service.prepareReviewDelivery(data), fake = github();
    const { persistReviewFailure, markReviewTerminal } = await import('../workers/job-state');
    await persistReviewFailure(data.jobId, userId, 'RETRYING', 'lost response');
    expect((await db.analysisJob.findUniqueOrThrow({ where: { id: data.jobId } })).results).toMatchObject({ suggestions: [finding], error: 'lost response' });
    const result = await service.deliverReviewPlan(plan, fake.api);
    await Promise.allSettled([record(data.jobId, repositoryId, result.artifact.suggestions, result.artifact), markReviewTerminal(data.jobId, userId, 'CANCELLED', 'cancel')]);
    const saved = await db.analysisJob.findUniqueOrThrow({ where: { id: data.jobId } });
    expect(['COMPLETED', 'CANCELLED']).toContain(saved.status);
    await persistReviewFailure(data.jobId, userId, 'FAILED', 'late failure');
    expect((await db.analysisJob.findUniqueOrThrow({ where: { id: data.jobId } })).status).toBe(saved.status);
  });
  it('rolls back preparation when the persisted destination violates a database constraint', async () => {
    const data = await input();
    // A database constraint violation inside the transaction must roll back all rows.
    await db.analysisJob.update({ where: { id: data.jobId }, data: { referenceId: String(2 ** 40) } });
    const invalid = { ...data, prNumber: 2 ** 40 };
    await expect(service.prepareReviewDelivery(invalid)).rejects.toThrow();
    expect(await service.loadReviewDelivery(data.jobId)).toBeNull();
    await db.analysisJob.update({ where: { id: data.jobId }, data: { referenceId: '42' } });
    expect((await service.prepareReviewDelivery(data)).deliveries).toHaveLength(1);
  });
  it('keeps a late accepted receipt after cancellation without completing the cancelled job', async () => {
    const data = await input(), plan = await service.prepareReviewDelivery(data), fake = github();
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    const pause = new Promise<void>(r => { release = r; });
    fake.gh.createReviewComment.mockImplementationOnce(async (_o, _r, _pr, _sha, path, _line, body) => { entered(); await pause; return fake.accept('INLINE', body, path); });
    const sending = service.deliverReviewPlan(plan, fake.api);
    await started;
    const { markReviewTerminal } = await import('../workers/job-state');
    await markReviewTerminal(data.jobId, userId, 'CANCELLED', 'cancelled');
    release(); await sending;
    expect((await reload(data.jobId)).deliveries[0].state).toBe('DELIVERED');
    expect((await db.analysisJob.findUniqueOrThrow({ where: { id: data.jobId } })).status).toBe('CANCELLED');
    expect(fake.gh.createReviewComment).toHaveBeenCalledOnce();
  });
  it('finalization-only recovery skips all GitHub I/O after a publication failure', async () => {
    const data = await input(), plan = await service.prepareReviewDelivery(data), fake = github();
    const result = await service.deliverReviewPlan(plan, fake.api);
    // Force a real transaction failure after receipt delivery: the next snapshot
    // overflows PostgreSQL's integer column. Completion and occurrences roll back.
    await db.analysisJob.update({ where: { id: data.jobId }, data: { findingSnapshot: 2147483647 } });
    await expect(record(data.jobId, repositoryId, result.artifact.suggestions, result.artifact)).rejects.toThrow();
    expect((await db.analysisJob.findUniqueOrThrow({ where: { id: data.jobId } })).status).toBe('POSTING');
    await db.analysisJob.update({ where: { id: data.jobId }, data: { findingSnapshot: 0 } });
    fake.gh.getPostingAuthorId.mockRejectedValue(new Error('GitHub offline'));
    fake.gh.getPullRequest.mockClear();
    const resumed = await service.deliverReviewPlan(await reload(data.jobId), fake.api);
    expect(fake.gh.getPullRequest).not.toHaveBeenCalled();
    await record(data.jobId, repositoryId, resumed.artifact.suggestions, resumed.artifact);
    expect(fake.gh.createReviewComment).toHaveBeenCalledOnce();
  });
  it('never treats an empty adapter response as proof of delivery', async () => {
    const data = await input(), plan = await service.prepareReviewDelivery(data), fake = github();
    fake.gh.createReviewComment.mockResolvedValueOnce(undefined as any);
    expect((await service.deliverReviewPlan(plan, fake.api)).artifact.commentDelivery.unconfirmed).toBe(1);
    expect((await reload(data.jobId)).deliveries[0].state).toBe('UNKNOWN');
  });
  it('refuses legacy preparation and changed authentication identities', async () => {
    const data = await input();
    await db.analysisJob.update({ where: { id: data.jobId }, data: { deliveryVersion: 0 } });
    await expect(service.prepareReviewDelivery(data)).rejects.toThrow('identity mismatch');
    await db.analysisJob.update({ where: { id: data.jobId }, data: { deliveryVersion: 1 } });
    const plan = await service.prepareReviewDelivery(data), fake = github();
    fake.gh.getPostingAuthorId.mockResolvedValue('8');
    await expect(service.deliverReviewPlan(plan, fake.api)).rejects.toThrow('identity changed');
    expect(fake.gh.createReviewComment).not.toHaveBeenCalled();
  });
  it('expires encrypted terminal artifacts after 90 days while keeping receipt identity', async () => {
    const data = await input(), plan = await service.prepareReviewDelivery(data), fake = github();
    await service.deliverReviewPlan(plan, fake.api);
    await db.analysisJob.update({ where: { id: data.jobId }, data: { status: 'COMPLETED' } });
    await db.reviewDeliveryPlan.update({ where: { id: plan.id }, data: { createdAt: new Date(0) } });
    expect(await service.purgeExpiredDeliveryPayloads()).toBeGreaterThanOrEqual(1);
    const expired = await reload(data.jobId);
    expect(expired.encryptedData).toBeNull(); expect(expired.deliveries[0].encryptedData).toBeNull();
    expect(expired.deliveries[0].githubCommentId).toBeTruthy(); expect(expired.deliveries[0].state).toBe('DELIVERED');
  });
  it('keeps failed tracked reviews through cleanup so reopening the same PR head stays deduplicated', async () => {
    const data = await input();
    await db.analysisJob.update({ where: { id: data.jobId }, data: { commitSha: data.headSha } });
    const plan = await service.prepareReviewDelivery(data), fake = github();
    await service.deliverReviewPlan(plan, fake.api);
    await db.analysisJob.update({ where: { id: data.jobId }, data: { status: 'FAILED', updatedAt: new Date(0) } });
    const { sweepFailedJobsOnce } = await import('../workers/job-retention');
    await sweepFailedJobsOnce(7);
    expect(await db.analysisJob.findUnique({ where: { id: data.jobId } })).not.toBeNull();
    expect((await reload(data.jobId)).deliveries[0].githubCommentId).toBeTruthy();
    const previous = await db.analysisJob.findUniqueOrThrow({ where: { id: data.jobId } });
    await expect(db.analysisJob.create({ data: { repositoryId, eventType: previous.eventType,
      referenceId: previous.referenceId, commitSha: previous.commitSha } })).rejects.toMatchObject({ code: 'P2002' });
  });
  it('purges disconnected payloads, preserves receipts, prevents late preparation, and cascades on deletion', async () => {
    const data = await input(), plan = await service.prepareReviewDelivery(data);
    await db.repository.update({ where: { id: repositoryId }, data: { isActive: false } });
    await service.purgeRepositoryDeliveryPayloads(repositoryId);
    expect((await reload(data.jobId)).encryptedData).toBeNull();
    expect((await reload(data.jobId)).deliveries[0].encryptedData).toBeNull();
    expect((await reload(data.jobId)).deliveries[0].state).toBe('OMITTED');
    await expect(service.prepareReviewDelivery(data)).rejects.toThrow('stopped');
    await db.repository.update({ where: { id: repositoryId }, data: { isActive: true } });
    expect((await reload(data.jobId)).deliveries[0].state).toBe('OMITTED');
    await db.analysisJob.delete({ where: { id: data.jobId } });
    expect(await db.commentDelivery.count({ where: { planId: plan.id } })).toBe(0);
  });
});
