import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubService } from './github.service';
import { normalizeStoredSuggestions, type AiSuggestion } from './ai/finding-taxonomy';

const { db, state } = vi.hoisted(() => {
  const state: any = { job: null, plan: null, deliveries: [], occurrences: [] };
  const matches = (row: any, where: any) => Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
    if (value && typeof value === 'object') {
      if ('in' in value) return value.in.includes(row[key]);
      if ('gt' in value) return row[key] > value.gt;
      if ('lte' in value) return row[key] <= value.lte;
    }
    return row[key] === value;
  });
  const db: any = {
    $queryRaw: vi.fn(async () => [{ id: 'repo' }]),
    repository: { findUnique: vi.fn(async () => ({ id: 'repo', userId: 'user', fullName: 'owner/repo', isActive: true })), update: vi.fn() },
    analysisJob: {
      findUnique: vi.fn(async () => ({ ...state.job, repository: await db.repository.findUnique() })),
      findUniqueOrThrow: vi.fn(async () => ({ ...state.job })),
      findFirst: vi.fn(async () => ({ ...state.job })),
      update: vi.fn(async ({ data }: any) => Object.assign(state.job, data)),
    },
    reviewDeliveryPlan: {
      findUnique: vi.fn(async () => state.plan && ({ ...state.plan, deliveries: state.deliveries.map((r: any) => ({ ...r })) })),
      create: vi.fn(async ({ data: { deliveries, ...data } }: any) => {
        state.plan = { id: 'plan', ...data };
        state.deliveries = deliveries.create.map((row: any) => ({ planId: 'plan', ...row }));
        return { ...state.plan, deliveries: state.deliveries.map((r: any) => ({ ...r })) };
      }),
    },
    commentDelivery: {
      create: vi.fn(async ({ data }: any) => { state.deliveries.push(data); return data; }),
      findMany: vi.fn(async ({ where }: any) => state.deliveries.filter((r: any) => matches(r, where)).map((r: any) => ({ ...r }))),
      findFirst: vi.fn(async ({ where }: any) => state.deliveries.find((r: any) => matches(r, where)) ?? null),
      findUniqueOrThrow: vi.fn(async ({ where }: any) => ({ ...state.deliveries.find((r: any) => matches(r, where)) })),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const rows = state.deliveries.filter((r: any) => matches(r, where));
        rows.forEach((row: any) => Object.entries(data).forEach(([key, value]: [string, any]) => {
          row[key] = value && typeof value === 'object' && 'increment' in value ? (row[key] ?? 0) + value.increment : value;
        }));
        return { count: rows.length };
      }),
    },
    findingOccurrence: { updateMany: vi.fn(), createMany: vi.fn(async ({ data }: any) => { state.occurrences.push(...data); }) },
    historicalPattern: { deleteMany: vi.fn() }, reviewAnalyticsFact: { create: vi.fn() },
  };
  db.$transaction = vi.fn(async (fn: any) => fn(db));
  return { db, state };
});
vi.mock('../config/prisma', () => ({ default: db }));

import { prepareReviewDelivery, deliverReviewPlan, loadReviewDelivery } from './comment-delivery.service';
import { recordJobFindings, snapshotIdentity, findingIdentity } from './historical/occurrence.service';
import { EncryptionService } from './encryption.service';
import { scanSast } from './security/probes/sast';
import { scanSecrets } from './security/probes/secrets';
import { verifiedLocationFixture } from '../test-utils/comment-locations';

const diff = (line: string) => `diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -0,0 +1 @@\n+${line}\n`;
const sast = scanSast(diff('eval(req.body.code);')).findings[0]!;
const secret = scanSecrets(diff(`const TOKEN = "ghp_${'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cD0fG3hJ6'}";`)).findings[0]!;

beforeEach(() => {
  vi.clearAllMocks();
  state.job = { id: 'job', repositoryId: 'repo', status: 'GENERATING', createdAt: new Date(),
    eventType: 'PULL_REQUEST', referenceId: '7', commitSha: 'head', deliveryVersion: 1, findingSnapshot: 0, findingSnapshotHash: null };
  state.plan = null; state.deliveries = []; state.occurrences = [];
});

function input(findings: AiSuggestion[] = [sast]) {
  const { suggestions, reviewedDiff } = verifiedLocationFixture(findings);
  return { jobId: 'job', repositoryId: 'repo', userId: 'user', headSha: 'head', baseSha: 'base', fullName: 'owner/repo',
    prNumber: 7, expectedAuthorId: '123', summaryBase: 'Saved review', reviewedDiff,
    artifact: { suggestions, config: { summarize: true }, risk: { verdict: 'BLOCK', score: 80 } } };
}
function github() {
  let id = 0;
  const receipt = async (..._args: unknown[]) => ({ ok: true as const, id: String(++id), url: `https://github.com/owner/repo/pull/7#comment-${id}` });
  const gh = { getPostingAuthorId: vi.fn(async () => '123'), getPullRequest: vi.fn(async () => ({ head: { sha: 'head' } })),
    listDeliveryComments: vi.fn(async () => ({ comments: [], complete: true })),
    createReviewComment: vi.fn(receipt), createIssueComment: vi.fn(receipt) };
  return { gh, api: gh as unknown as GitHubService };
}

describe('security review delivery and completion with real services', () => {
  it.each([['SAST', sast], ['SECRETS', secret]] as const)('completes a delivered %s finding and safely resumes without reposting', async (_probe, finding) => {
    expect(finding.ruleKey).toBeTruthy();
    const plan = await prepareReviewDelivery(input([finding]));
    const fake = github();
    const { artifact } = await deliverReviewPlan(plan, fake.api);
    expect(fake.gh.createReviewComment).toHaveBeenCalledOnce();
    expect(fake.gh.createIssueComment).toHaveBeenCalledOnce();
    await recordJobFindings('job', 'repo', artifact.suggestions, artifact);
    expect(state.job.status).toBe('COMPLETED');
    expect(state.job.results.risk).toEqual({ verdict: 'BLOCK', score: 80 });
    expect(state.occurrences).toHaveLength(1);
    expect(state.occurrences[0].ruleKeys).toContain(finding.ruleKey);
    const resumed = await deliverReviewPlan((await loadReviewDelivery('job'))!);
    await recordJobFindings('job', 'repo', resumed.artifact.suggestions, resumed.artifact);
    expect(state.occurrences).toHaveLength(1);
    expect(fake.gh.createReviewComment).toHaveBeenCalledOnce();
    expect(fake.gh.createIssueComment).toHaveBeenCalledOnce();
  });

  it('normalizes before deduplication and keeps the frozen artifact and row identities consistent', async () => {
    const alias = { ...sast, ruleKey: undefined, ruleKeys: [sast.ruleKey] };
    const plan = await prepareReviewDelivery(input([sast, alias]));
    const frozen = JSON.parse(await EncryptionService.decrypt(plan.encryptedData!, plan.iv!, plan.authTag!, plan.salt!));
    expect(frozen.suggestions).toMatchObject(normalizeStoredSuggestions([sast]));
    expect(plan.artifactHash).toBe(snapshotIdentity(frozen.suggestions));
    expect(plan.deliveries.filter(r => r.kind === 'INLINE')).toHaveLength(1);
    expect(plan.deliveries.find(r => r.kind === 'INLINE')!.findingKey).toBe(findingIdentity(frozen.suggestions[0]));
  });

  it('keeps provenance normalization stable when a singular rule alias meets the key limit', async () => {
    const finding = { ...sast, ruleKeys: Array.from({ length: 20 }, (_, index) => `rule-${index}`),
      sources: ['SAST', 'SAST', 'LLM'] as AiSuggestion['sources'] };
    const normalized = normalizeStoredSuggestions([finding]);
    expect(normalized[0]!.ruleKeys).toHaveLength(20);
    expect(normalizeStoredSuggestions(normalized)).toEqual(normalized);
    const plan = await prepareReviewDelivery(input([finding]));
    const { artifact } = await deliverReviewPlan(plan, github().api);
    await recordJobFindings('job', 'repo', artifact.suggestions, artifact);
    expect(state.job.status).toBe('COMPLETED');
  });

  it('completes an ordinary model finding too', async () => {
    const finding: AiSuggestion = { filePath: 'src/a.ts', lineNumber: 1, agentType: 'BUG', priority: 'HIGH', issue: 'Null dereference', suggestion: 'Guard null' };
    const plan = await prepareReviewDelivery(input([finding]));
    const { artifact } = await deliverReviewPlan(plan, github().api);
    await recordJobFindings('job', 'repo', artifact.suggestions, artifact);
    expect(state.job.status).toBe('COMPLETED');
  });

  async function oldPlan() {
    const data = input();
    await prepareReviewDelivery(data);
    // Reconstruct a pre-fix plan: the encrypted artifact, plan hash, and inline
    // keys all use the scanner's raw ruleKey representation.
    Object.assign(state.plan, await EncryptionService.encrypt(JSON.stringify({ ...data.artifact, summaryBase: data.summaryBase })), {
      artifactHash: snapshotIdentity(data.artifact.suggestions),
    });
    const inline = state.deliveries.find((row: any) => row.kind === 'INLINE');
    inline.findingKey = findingIdentity(sast);
    inline.deliveryKey = `inline:v1:${inline.findingKey}`;
    return (await loadReviewDelivery('job'))!;
  }

  it('recovers an old raw-hash plan through a summary without changing its hash or guessing inline lines', async () => {
    const plan = await oldPlan(), fake = github();
    const { artifact } = await deliverReviewPlan(plan, fake.api);
    expect(plan.artifactHash).not.toBe(snapshotIdentity(normalizeStoredSuggestions(artifact.suggestions)));
    await recordJobFindings('job', 'repo', artifact.suggestions, artifact);
    expect(state.job.status).toBe('COMPLETED');
    expect(state.plan.artifactHash).toBe(plan.artifactHash);
    expect(state.occurrences[0].ruleKeys).toEqual([sast.ruleKey]);
    const resumed = await deliverReviewPlan((await loadReviewDelivery('job'))!);
    await recordJobFindings('job', 'repo', resumed.artifact.suggestions, resumed.artifact);
    expect(state.occurrences).toHaveLength(1);
    expect(fake.gh.createReviewComment).not.toHaveBeenCalled();
    expect(fake.gh.createIssueComment).toHaveBeenCalledOnce();
  });

  it('retains unverified model findings in one summary even with routine summaries disabled', async () => {
    const finding: AiSuggestion = { filePath: 'src/a.ts', lineNumber: 99, agentType: 'BUG', priority: 'HIGH', issue: 'Null dereference', suggestion: 'Guard null' };
    const data = input([finding]);
    delete data.artifact.suggestions[0]!.verifiedAnchor;
    data.artifact.config.summarize = false;
    const plan = await prepareReviewDelivery(data), fake = github();
    expect(plan.deliveries.find(r => r.kind === 'INLINE')).toMatchObject({ state: 'OMITTED', reason: 'location-unverified' });
    const { artifact } = await deliverReviewPlan(plan, fake.api);
    expect(fake.gh.createReviewComment).not.toHaveBeenCalled(); expect(fake.gh.createIssueComment).toHaveBeenCalledOnce();
    expect(fake.gh.createIssueComment.mock.calls[0]![3]).toContain('Findings without a verified code location');
    expect(fake.gh.createIssueComment.mock.calls[0]![3]).not.toContain('```suggestion');
    await recordJobFindings('job', 'repo', artifact.suggestions, artifact);
    expect(state.job.status).toBe('COMPLETED'); expect(state.occurrences).toHaveLength(1);
    await deliverReviewPlan((await loadReviewDelivery('job'))!);
    expect(fake.gh.createIssueComment).toHaveBeenCalledOnce();
  });

  it('independently refuses a model label whose path/line differs from the reviewed diff', async () => {
    const finding: AiSuggestion = { filePath: 'src/a.ts', lineNumber: 1, agentType: 'BUG', priority: 'HIGH', issue: 'Bad access', suggestion: 'Guard null' };
    const data = input([finding]); data.artifact.suggestions[0]!.lineNumber = 2;
    const plan = await prepareReviewDelivery(data), fake = github();
    await deliverReviewPlan(plan, fake.api);
    expect(fake.gh.createReviewComment).not.toHaveBeenCalled(); expect(fake.gh.createIssueComment).toHaveBeenCalledOnce();
  });

  it('adds exactly one durable fallback slot for a pending legacy plan that disabled summaries', async () => {
    const plan = await oldPlan();
    state.deliveries = state.deliveries.filter((row: any) => row.kind === 'INLINE');
    const fake = github();
    await deliverReviewPlan((await loadReviewDelivery('job'))!, fake.api);
    expect(state.deliveries.filter((row: any) => row.kind === 'SUMMARY')).toHaveLength(1);
    expect(fake.gh.createReviewComment).not.toHaveBeenCalled(); expect(fake.gh.createIssueComment).toHaveBeenCalledOnce();
    await deliverReviewPlan((await loadReviewDelivery('job'))!);
    expect(fake.gh.createIssueComment).toHaveBeenCalledOnce(); expect(state.plan.artifactHash).toBe(plan.artifactHash);
  });

  it('preserves already delivered legacy inline receipts without reposting or adding a new summary', async () => {
    await oldPlan(); state.deliveries = state.deliveries.filter((row: any) => row.kind === 'INLINE');
    state.deliveries[0].state = 'DELIVERED'; state.deliveries[0].githubCommentId = '42';
    const result = await deliverReviewPlan((await loadReviewDelivery('job'))!);
    expect(result.artifact.commentDelivery.delivered).toBe(1); expect(state.deliveries).toHaveLength(1);
  });
  it('recovers a crash after omitting legacy inline sends but before adding the fallback slot', async () => {
    await oldPlan(); state.deliveries = state.deliveries.filter((row: any) => row.kind === 'INLINE');
    state.deliveries[0].state = 'OMITTED'; state.deliveries[0].reason = 'location-unverified';
    const fake = github();
    await deliverReviewPlan((await loadReviewDelivery('job'))!, fake.api);
    expect(fake.gh.createReviewComment).not.toHaveBeenCalled(); expect(fake.gh.createIssueComment).toHaveBeenCalledOnce();
    await deliverReviewPlan((await loadReviewDelivery('job'))!);
    expect(fake.gh.createIssueComment).toHaveBeenCalledOnce();
  });
  it.each(['UNKNOWN', 'SENDING'])('never blindly repeats a legacy %s inline send', async status => {
    await oldPlan(); state.deliveries[0].state = status;
    state.deliveries[0].claimExpiresAt = new Date(Date.now() - 1000);
    const fake = github();
    await expect(deliverReviewPlan((await loadReviewDelivery('job'))!, fake.api)).rejects.toThrow('unconfirmed');
    expect(fake.gh.createReviewComment).not.toHaveBeenCalled(); expect(fake.gh.createIssueComment).not.toHaveBeenCalled();
  });
  it('rejects a stored inline destination changed after the location was frozen', async () => {
    const plan = await prepareReviewDelivery(input()), fake = github();
    state.deliveries.find((row: any) => row.kind === 'INLINE').line = 2;
    await deliverReviewPlan(plan, fake.api);
    expect(fake.gh.createReviewComment).not.toHaveBeenCalled(); expect(fake.gh.createIssueComment).toHaveBeenCalledOnce();
  });

  it.each(['issue', 'suggestion', 'filePath', 'lineNumber', 'priority', 'source', 'ruleKey'])(
    'still rejects changed %s on an old plan', async field => {
      const plan = await oldPlan();
      const { artifact } = await deliverReviewPlan(plan, github().api);
      const changed = { ...artifact.suggestions[0], [field]: field === 'lineNumber' ? 99 : field === 'priority' ? 'LOW' : field === 'source' ? 'SECRETS' : 'changed' };
      await expect(recordJobFindings('job', 'repo', [changed], { ...artifact, suggestions: [changed] })).rejects.toThrow('review changed');
      expect(state.job.status).toBe('POSTING');
      expect(state.occurrences).toHaveLength(0);
    },
  );

  it.each(['hash', 'ciphertext', 'missing-payload'])('rejects damaged old-plan %s instead of bypassing the fingerprint check', async damage => {
    const plan = await oldPlan();
    const { artifact } = await deliverReviewPlan(plan, github().api);
    if (damage === 'hash') state.plan.artifactHash = 'wrong-hash';
    if (damage === 'ciphertext') state.plan.encryptedData = 'invalid-ciphertext';
    if (damage === 'missing-payload') state.plan.encryptedData = null;
    await expect(recordJobFindings('job', 'repo', artifact.suggestions, artifact)).rejects.toThrow('review changed');
    expect(state.job.status).toBe('POSTING');
  });

  it('does not complete an old plan with unfinished comments', async () => {
    await oldPlan();
    await expect(recordJobFindings('job', 'repo', [sast], input().artifact)).rejects.toThrow('unfinished');
    expect(state.job.status).toBe('POSTING');
  });

  it.each(['FAILED', 'CANCELLED', 'TIMEOUT'])('does not resurrect a %s review', async status => {
    const plan = await prepareReviewDelivery(input());
    const { artifact } = await deliverReviewPlan(plan, github().api);
    state.job.status = status;
    await expect(recordJobFindings('job', 'repo', artifact.suggestions, artifact)).rejects.toThrow('terminal');
    expect(state.job.status).toBe(status);
  });
});
