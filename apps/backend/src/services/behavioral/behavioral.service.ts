import { createHash, randomBytes } from 'node:crypto';
import { Prisma, type BehavioralRun } from '@prisma/client';
import prisma from '../../config/prisma';
import type { GitHubService } from '../github.service';
import type { TestGapReport } from '../test-gap/test-gap-types';
import { baselineBehavioral, LIMITS, outcome, parseEvidence, parsePlan, withExecution, WORKFLOW_PATH, type BehavioralReport, type Scenario, type ScenarioResult } from './contracts';
import { previewHost, resolvePublic, validateDestination } from './destination-policy';

export class BehavioralError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export interface BehavioralConfig { enabled: boolean; workflowSha: string; previewHost: string; environment: string; publishers: string[] }
export function parseBehavioralConfig(value: unknown): BehavioralConfig {
  const c = value as Record<string, unknown> | null;
  if (!c || typeof c.enabled !== 'boolean' || typeof c.workflowSha !== 'string' || !/^[a-f0-9]{40}$/.test(c.workflowSha) || typeof c.environment !== 'string' || !/^[a-zA-Z0-9_-]{1,60}$/.test(c.environment) || !Array.isArray(c.publishers) || !c.publishers.length || c.publishers.length > 5 || c.publishers.some(v => typeof v !== 'string' || !/^[a-zA-Z0-9_-]+(?:\[bot\])?$/.test(v))) throw new BehavioralError(400, 'Invalid CI/preview configuration');
  return { enabled: c.enabled, workflowSha: c.workflowSha, previewHost: previewHost(c.previewHost), environment: c.environment, publishers: c.publishers as string[] };
}
export function resultsObject(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}
function priorReport(results: Record<string, any>, headSha: string): BehavioralReport {
  const baseline = baselineBehavioral(results.testGaps);
  const prior = results.behavioral as BehavioralReport | undefined;
  if (prior?.version !== 1 || prior.headSha !== headSha || !Array.isArray(prior.scenarios)) return baseline;
  return { ...baseline, ...prior, scenarios: baseline.scenarios.map(s => prior.scenarios.find(p => p.id === s.id) ?? s) };
}
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
export function authenticDispatch(token: unknown, hash: string): boolean {
  return typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) && digest(token) === hash;
}
export function runDto(run: BehavioralRun) {
  return { id: run.id, status: run.status, plan: run.plan, evidence: run.evidence, reason: run.reason, headSha: run.headSha, ciRunId: run.ciRunId, createdAt: run.createdAt, deadlineAt: run.deadlineAt, expiresAt: run.expiresAt };
}
export async function trustedPreview(gh: GitHubService, fullName: string, deploymentId: number | null, headSha: string, config: BehavioralConfig) {
  if (!deploymentId) return null;
  const [owner, repo] = fullName.split('/');
  const preview = await gh.getDeploymentPreview(owner, repo, deploymentId);
  if (preview.sha !== headSha || preview.environment !== config.environment || preview.state !== 'success' || !preview.publisher || !config.publishers.includes(preview.publisher) || !preview.url) return null;
  const url = validateDestination(preview.url, config.previewHost);
  // Preview metadata is an origin, never a bearer link or URL with credentials.
  if (url.search || url.pathname !== '/') throw new BehavioralError(400, 'Preview metadata must contain a credential-free origin URL');
  await resolvePublic(url.hostname);
  return url.origin;
}
export async function startBehavioralRun(job: any, body: Record<string, unknown>, gh: GitHubService) {
  if (body.confirmed !== true) throw new BehavioralError(400, 'Explicit execution confirmation is required');
  if (typeof body.requestKey !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(body.requestKey)) throw new BehavioralError(400, 'A stable requestKey is required');
  const prior = await prisma.behavioralRun.findUnique({ where: { analysisJobId_requestKey: { analysisJobId: job.id, requestKey: body.requestKey } } });
  if (prior) return prior; // No redispatch, even after an ambiguous API response.
  if (job.status !== 'COMPLETED' || !job.commitSha || !/^[a-f0-9]{40}$/.test(job.commitSha)) throw new BehavioralError(409, 'A completed review with a pinned commit is required');
  if (!job.repository.installationId || !job.repository.installation || job.repository.installation.userId !== job.repository.userId) throw new BehavioralError(403, 'An owned GitHub App installation is required');
  const config = parseBehavioralConfig(job.repository.behavioralConfig);
  if (!config.enabled) throw new BehavioralError(409, 'Behavioral verification is disabled');
  const results = resultsObject(job.results);
  if (!results.testGaps?.analyzed || !Array.isArray(results.testGaps.scenarios)) throw new BehavioralError(409, 'Phase 5 test-gap scenarios are required');
  const baseline = baselineBehavioral(results.testGaps as TestGapReport);
  const plan = parsePlan(body.scenarios, baseline.scenarios.map(s => s.id));
  const deploymentId = body.deploymentId == null ? null : Number(body.deploymentId);
  if (deploymentId !== null && (!Number.isSafeInteger(deploymentId) || deploymentId <= 0 || deploymentId > 2_147_483_647)) throw new BehavioralError(400, 'Invalid deployment ID');
  const [owner, repo] = job.repository.fullName.split('/');
  const repoInfo = await gh.getRepo(owner, repo);
  if (String(repoInfo.id) !== String(job.repository.githubRepoId)) throw new BehavioralError(409, 'Repository identity changed');
  const branch = repoInfo.default_branch;
  if (await gh.getBranchHeadSha(owner, repo, branch) !== config.workflowSha) throw new BehavioralError(409, 'Trusted workflow revision changed; review and update the CI pin');
  if (job.eventType === 'PULL_REQUEST') {
    const pr = await gh.getPullRequest(owner, repo, Number(job.referenceId));
    if (pr.head.sha !== job.commitSha) throw new BehavioralError(409, 'Source PR changed; review its current commit first');
  }
  const previewUrl = await trustedPreview(gh, job.repository.fullName, deploymentId, job.commitSha, config);
  const dispatchToken = randomBytes(32).toString('hex');
  const now = new Date();
  let run: BehavioralRun;
  // Serializable reservation bounds concurrent requests too. A serialization
  // conflict is returned as a retryable 409; no GitHub write has occurred.
  try {
    run = await prisma.$transaction(async tx => {
      const duplicate = await tx.behavioralRun.findUnique({ where: { analysisJobId_requestKey: { analysisJobId: job.id, requestKey: body.requestKey as string } } });
      if (duplicate) return duplicate;
      const [jobCount, dayCount, active] = await Promise.all([
        tx.behavioralRun.count({ where: { analysisJobId: job.id } }),
        tx.behavioralRun.count({ where: { repositoryId: job.repositoryId, createdAt: { gte: new Date(now.getTime() - 86400000) } } }),
        tx.behavioralRun.count({ where: { repositoryId: job.repositoryId, status: { in: ['QUEUED', 'RUNNING'] }, deadlineAt: { gt: now } } }),
      ]);
      if (jobCount >= LIMITS.runsPerJob || dayCount >= LIMITS.runsPerDay || active) throw new BehavioralError(429, 'Behavioral execution limit reached');
      return tx.behavioralRun.create({ data: { analysisJobId: job.id, repositoryId: job.repositoryId, requestKey: body.requestKey as string, headSha: job.commitSha, plan: plan as any, status: previewUrl ? 'QUEUED' : 'NOT_RUN', reason: previewUrl ? null : 'NO_TRUSTED_PREVIEW', previewUrl, deploymentId, workflowSha: config.workflowSha, workflowRef: `${job.repository.fullName}/${WORKFLOW_PATH}@refs/heads/${branch}`, dispatchHash: digest(dispatchToken), deadlineAt: new Date(now.getTime() + 10 * 60_000), expiresAt: new Date(now.getTime() + LIMITS.retentionDays * 86400000) } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (err) {
    if (err instanceof BehavioralError) throw err;
    throw new BehavioralError(409, 'Concurrent request; retry using the same requestKey');
  }
  // A duplicate returned by the transaction must never be dispatched again.
  if (run.dispatchHash !== digest(dispatchToken) || !previewUrl) return run;
  try {
    await gh.dispatchBehavioralWorkflow(owner, repo, branch, run.id, dispatchToken);
  } catch {
    // A timeout may mean GitHub accepted the dispatch. Leave it claimable;
    // never resend. The deadline sweep makes a lost dispatch TIMED_OUT.
    return prisma.behavioralRun.update({ where: { id: run.id }, data: { reason: 'DISPATCH_UNCONFIRMED: GitHub response unavailable; no automatic retry.' } });
  }
  return run;
}

/** Atomically accept one authenticated CI result and snapshot a content-free summary. */
export async function completeBehavioralRun(run: BehavioralRun, ciRunId: string, raw: unknown) {
  const plan = run.plan as unknown as Scenario[];
  const evidence = parseEvidence(raw, plan);
  return prisma.$transaction(async tx => {
    const changed = await tx.behavioralRun.updateMany({ where: { id: run.id, status: 'RUNNING', ciRunId, deadlineAt: { gt: new Date() } }, data: { status: outcome(evidence), evidence: evidence as any, reason: null } });
    if (!changed.count) {
      const prior = await tx.behavioralRun.findUnique({ where: { id: run.id } });
      if (prior?.ciRunId === ciRunId && JSON.stringify(prior.evidence) === JSON.stringify(evidence)) return prior;
      throw new BehavioralError(409, 'Run expired or already completed');
    }
    const job = await tx.analysisJob.findUniqueOrThrow({ where: { id: run.analysisJobId } });
    const results = resultsObject(job.results);
    const baseline = priorReport(results, run.headSha);
    const report = withExecution(baseline, evidence, { ...run, ciRunId });
    // No observed content is retained in the job summary. Plans and step
    // outcomes expire separately after seven days.
    await tx.analysisJob.update({ where: { id: job.id }, data: { results: { ...results, behavioral: report } as any } });
    return tx.behavioralRun.findUniqueOrThrow({ where: { id: run.id } });
  });
}

export function behavioralForJob(results: Record<string, any>, runs: BehavioralRun[] = []): BehavioralReport | undefined {
  if (!results.testGaps && !results.behavioral) return undefined;
  const latest = runs[0];
  const baseline = latest ? priorReport(results, latest.headSha) : baselineBehavioral(results.testGaps);
  if (!latest) return results.behavioral ?? baseline;
  const plan = latest.plan as unknown as Scenario[];
  const expired = ['QUEUED', 'RUNNING'].includes(latest.status) && latest.deadlineAt.getTime() <= Date.now();
  const fallback = plan.map(s => ({ id: s.id, status: expired ? 'TIMED_OUT' : ['ERROR', 'TIMED_OUT'].includes(latest.status) ? latest.status : 'NOT_RUN', steps: [] })) as ScenarioResult[];
  const report = withExecution(baseline, latest.evidence ? latest.evidence as unknown as ScenarioResult[] : fallback, latest);
  if (expired) report.reason = 'CI_DEADLINE_EXCEEDED';
  else if (latest.status === 'QUEUED' || latest.status === 'RUNNING') report.reason = latest.status;
  return report;
}
