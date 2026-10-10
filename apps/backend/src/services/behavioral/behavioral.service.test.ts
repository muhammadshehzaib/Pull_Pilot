import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ find: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn(), cas: vi.fn(), transaction: vi.fn(), job: vi.fn(), snapshot: vi.fn(), dns: vi.fn() }));
vi.mock('../../config/prisma', () => ({ default: { behavioralRun: { findUnique: m.find, update: m.update }, $transaction: m.transaction } }));
vi.mock('./destination-policy', async original => ({ ...await original<any>(), resolvePublic: m.dns }));
import { baselineBehavioral, type Scenario } from './contracts';
import { behavioralForJob, completeBehavioralRun, startBehavioralRun, trustedPreview } from './behavioral.service';
const sha = 'a'.repeat(40);
const config = { enabled: true, workflowSha: sha, previewHost: 'preview.example.com', environment: 'preview', publishers: ['deploy[bot]'] };
const gaps = { analyzed: true, scenarios: [{ filePath: 'a.ts', scenario: 'opens cart', lineNumber: 1, expected: 'visible', confidence: 'HIGH' as const }], evidence: { changedSources: ['a.ts'], relatedTests: [], treeTruncated: false, incomplete: false } };
const id = baselineBehavioral(gaps).scenarios[0].id;
const plan: Scenario[] = [{ id, steps: [{ action: 'navigate', path: '/' }, { action: 'assertVisible', testId: 'cart' }] }];
const job = { id: 'job', status: 'COMPLETED', eventType: 'PULL_REQUEST', referenceId: '1', repositoryId: 'repo', commitSha: sha, results: { testGaps: gaps, suggestions: [] }, repository: { fullName: 'o/r', githubRepoId: 42n, userId: 'owner', installationId: 'i', installation: { userId: 'owner' }, behavioralConfig: config } };
const request = { confirmed: true, requestKey: 'stable-request-123', deploymentId: 42, scenarios: plan };
function github() { return { getRepo: vi.fn().mockResolvedValue({ id: 42, default_branch: 'main' }), getBranchHeadSha: vi.fn().mockResolvedValue(sha), getPullRequest: vi.fn().mockResolvedValue({ head: { sha } }), getDeploymentPreview: vi.fn().mockResolvedValue({ sha, environment: 'preview', state: 'success', url: 'https://preview.example.com', publisher: 'deploy[bot]' }), dispatchBehavioralWorkflow: vi.fn().mockResolvedValue(undefined) }; }
beforeEach(() => {
  vi.resetAllMocks(); m.dns.mockResolvedValue({ address: '8.8.8.8', family: 4 }); m.count.mockResolvedValue(0); m.create.mockImplementation(async ({ data }) => ({ id: 'run', ...data }));
  m.transaction.mockImplementation(async fn => fn({ behavioralRun: { findUnique: m.find, findUniqueOrThrow: m.find, count: m.count, create: m.create, updateMany: m.cas }, analysisJob: { findUniqueOrThrow: m.job, update: m.snapshot } }));
});
describe('behavioral dispatch', () => {
  it('creates and dispatches one explicit plan from a pinned owner workflow', async () => {
    const gh = github(); const run = await startBehavioralRun(job, request, gh as any);
    expect(run.status).toBe('QUEUED');
    expect(gh.dispatchBehavioralWorkflow).toHaveBeenCalledWith('o', 'r', 'main', 'run', expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(run.dispatchHash).not.toBe(gh.dispatchBehavioralWorkflow.mock.calls[0][4]);
  });
  it('keeps missing/unsuccessful preview NOT_RUN without dispatch', async () => {
    const gh = github(); gh.getDeploymentPreview.mockResolvedValue({ sha, environment: 'preview', state: 'pending', url: 'https://preview.example.com', publisher: 'deploy[bot]' });
    const run = await startBehavioralRun(job, request, gh as any);
    expect(run.status).toBe('NOT_RUN'); expect(run.reason).toBe('NO_TRUSTED_PREVIEW'); expect(gh.dispatchBehavioralWorkflow).not.toHaveBeenCalled();
  });
  it.each(['pr', 'workflow'] as const)('rejects a stale %s before dispatch', async stale => {
    const gh = github();
    if (stale === 'pr') gh.getPullRequest.mockResolvedValue({ head: { sha: 'b'.repeat(40) } });
    else gh.getBranchHeadSha.mockResolvedValue('b'.repeat(40));
    await expect(startBehavioralRun(job, request, gh as any)).rejects.toMatchObject({ status: 409 });
    expect(m.create).not.toHaveBeenCalled(); expect(gh.dispatchBehavioralWorkflow).not.toHaveBeenCalled();
  });
  it('returns duplicate submissions without a second dispatch', async () => {
    m.find.mockResolvedValue({ id: 'existing', status: 'QUEUED' }); const gh = github();
    expect((await startBehavioralRun(job, request, gh as any)).id).toBe('existing');
    expect(gh.dispatchBehavioralWorkflow).not.toHaveBeenCalled(); expect(m.create).not.toHaveBeenCalled();
  });
  it('preserves an ambiguous dispatch error and does not claim success', async () => {
    const gh = github(); gh.dispatchBehavioralWorkflow.mockRejectedValue(new Error('token and full content must not escape'));
    m.update.mockImplementation(async ({ data }) => ({ id: 'run', status: 'QUEUED', ...data }));
    const run = await startBehavioralRun(job, request, gh as any);
    expect(run.status).toBe('QUEUED'); expect(run.reason).toMatch(/UNCONFIRMED/); expect(JSON.stringify(run)).not.toContain('token and full content');
  });
  it.each([403, 404, 422, 429])('persists definitive GitHub rejection %s as ERROR without losing the plan', async status => {
    const gh = github(); gh.dispatchBehavioralWorkflow.mockRejectedValue(Object.assign(new Error('sensitive server body'), { status }));
    m.update.mockImplementation(async ({ data }) => ({ id: 'run', plan, ...data }));
    const run = await startBehavioralRun(job, request, gh as any);
    expect(run.status).toBe('ERROR'); expect(run.plan).toEqual(plan);
    expect(JSON.stringify(run)).not.toContain('sensitive server body');
  });
  it('bounds daily and concurrent reservations', async () => {
    m.count.mockResolvedValue(10);
    await expect(startBehavioralRun(job, request, github() as any)).rejects.toMatchObject({ status: 429 });
    expect(m.create).not.toHaveBeenCalled();
  });
  it('rejects an unapproved publisher, wrong commit and credential-bearing metadata', async () => {
    const gh = github();
    for (const extra of [{ publisher: 'attacker' }, { sha: 'b'.repeat(40) }]) {
      gh.getDeploymentPreview.mockResolvedValue({ sha, environment: 'preview', state: 'success', url: 'https://preview.example.com', publisher: 'deploy[bot]', ...extra });
      expect(await trustedPreview(gh as any, 'o/r', 42, sha, config)).toBeNull();
    }
    gh.getDeploymentPreview.mockResolvedValue({ sha, environment: 'preview', state: 'success', url: 'https://preview.example.com/?token=secret', publisher: 'deploy[bot]' });
    await expect(trustedPreview(gh as any, 'o/r', 42, sha, config)).rejects.toThrow();
  });
});
describe('behavioral persistence', () => {
  const run = { id: 'run', analysisJobId: 'job', headSha: sha, plan, ciRunId: '1', reason: null };
  const evidence = [{ id, status: 'PASSED', steps: [{ index: 0, status: 'PASSED' }, { index: 1, status: 'PASSED' }] }];
  it('atomically snapshots executed outcomes without runner source/content', async () => {
    m.cas.mockResolvedValue({ count: 1 }); m.job.mockResolvedValue(job); m.find.mockResolvedValue({ ...run, status: 'PASSED' });
    await completeBehavioralRun(run as any, '1', evidence);
    expect(m.cas).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'RUNNING', ciRunId: '1', deadlineAt: expect.anything() }) }));
    expect(m.snapshot.mock.calls[0][0].data.results.behavioral.scenarios[0]).toMatchObject({ status: 'PASSED', stage: 'VERIFIED' });
    expect(m.snapshot.mock.calls[0][0].data.results.suggestions).toEqual([]);
  });
  it('accepts a result retry but refuses changed or expired evidence', async () => {
    m.cas.mockResolvedValue({ count: 0 }); m.find.mockResolvedValue({ ...run, evidence });
    expect(await completeBehavioralRun(run as any, '1', evidence)).toMatchObject({ id: 'run' });
    await expect(completeBehavioralRun(run as any, '2', evidence)).rejects.toMatchObject({ status: 409 });
    expect(m.snapshot).not.toHaveBeenCalled();
  });
  it('retains prior failure evidence when a later run has no executed assertions', async () => {
    m.cas.mockResolvedValue({ count: 1 });
    m.job.mockResolvedValue({ ...job, results: { ...job.results, behavioral: { ...baselineBehavioral(gaps), headSha: sha, scenarios: [{ ...baselineBehavioral(gaps).scenarios[0], status: 'FAILED', stage: 'EXECUTED', lastAssertionStatus: 'FAILED', lastAssertionRunId: 'prior' }] } } });
    m.find.mockResolvedValue({ ...run, status: 'ERROR' });
    await completeBehavioralRun(run as any, '1', [{ id, status: 'ERROR', steps: [] }]);
    expect(m.snapshot.mock.calls[0][0].data.results.behavioral.scenarios[0]).toMatchObject({ status: 'ERROR', stage: 'GENERATED', lastAssertionStatus: 'FAILED', lastAssertionRunId: 'prior' });
  });
  it('reports expired execution as TIMED_OUT, never PASS, and supports old jobs', () => {
    expect(behavioralForJob({})).toBeUndefined();
    const report = behavioralForJob(job.results, [{ ...run, status: 'QUEUED', deadlineAt: new Date(0), evidence: null } as any]);
    expect(report?.scenarios[0]).toMatchObject({ status: 'TIMED_OUT', stage: 'GENERATED' });
  });
});
