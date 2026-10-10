import type { Request, Response } from 'express';
import prisma from '../config/prisma';
import { GitHubAppService } from '../services/github-app.service';
import { authenticDispatch, BehavioralError, behavioralForJob, completeBehavioralRun, parseBehavioralConfig, resultsObject, runDto, startBehavioralRun, trustedPreview } from '../services/behavioral/behavioral.service';
import { verifyCiToken } from '../services/behavioral/oidc';
import { LIMITS } from '../services/behavioral/contracts';

async function ownedJob(req: Request) {
  const job = await prisma.analysisJob.findFirst({ where: { id: String(req.params.jobId), repository: { userId: req.auth!.userId, isActive: true } }, include: { repository: { include: { installation: true } } } });
  if (!job) throw new BehavioralError(404, 'Review not found');
  return job;
}
function failure(res: Response, error: unknown) {
  return res.status(error instanceof BehavioralError ? error.status : 400).json({ error: error instanceof BehavioralError ? error.message : 'Invalid request or unavailable CI/preview service' });
}
async function ciContext(req: Request) {
  const run = await prisma.behavioralRun.findUnique({ where: { id: String(req.params.runId) }, include: { repository: { include: { installation: true } } } });
  if (!run || !authenticDispatch(req.body?.dispatchToken, run.dispatchHash)) throw new BehavioralError(401, 'CI authentication failed');
  if (run.expiresAt.getTime() <= Date.now() || run.deadlineAt.getTime() <= Date.now()) throw new BehavioralError(409, 'CI run expired');
  const config = parseBehavioralConfig(run.repository.behavioralConfig);
  if (!run.repository.isActive || !config.enabled || config.workflowSha !== run.workflowSha || !run.previewUrl || new URL(run.previewUrl).hostname !== config.previewHost || !run.repository.installation || run.repository.installation.userId !== run.repository.userId) throw new BehavioralError(403, 'CI configuration was revoked or changed');
  const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
  let identity;
  try { identity = await verifyCiToken(token, { repositoryId: String(run.repository.githubRepoId), workflowRef: run.workflowRef, workflowSha: run.workflowSha, audience: process.env.BEHAVIORAL_OIDC_AUDIENCE ?? '' }); }
  catch { throw new BehavioralError(401, 'CI authentication failed'); }
  if (run.ciRunId && run.ciRunId !== identity.runId) throw new BehavioralError(409, 'Another CI run already claimed this plan');
  return { run, identity, config };
}

export class BehavioralController {
  static async get(req: Request, res: Response) {
    try {
      const job = await ownedJob(req);
      const runs = await prisma.behavioralRun.findMany({ where: { analysisJobId: job.id, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' }, take: LIMITS.runsPerJob });
      return res.json({ config: job.repository.behavioralConfig, report: behavioralForJob(resultsObject(job.results), runs), runs: runs.map(runDto) });
    } catch (err) { return failure(res, err); }
  }
  static async configure(req: Request, res: Response) {
    try {
      const job = await ownedJob(req);
      if (req.body?.confirmed !== true) throw new BehavioralError(400, 'Explicit owner confirmation is required');
      const config = parseBehavioralConfig(req.body.config);
      if (!job.repository.installation || job.repository.installation.userId !== req.auth!.userId) throw new BehavioralError(403, 'An owned GitHub App installation is required');
      await prisma.repository.update({ where: { id: job.repositoryId }, data: { behavioralConfig: config as any } });
      return res.json({ config });
    } catch (err) { return failure(res, err); }
  }
  static async start(req: Request, res: Response) {
    try {
      const job = await ownedJob(req);
      if (!process.env.BEHAVIORAL_OIDC_AUDIENCE) throw new BehavioralError(503, 'Configure BEHAVIORAL_OIDC_AUDIENCE before enabling CI');
      const gh = await GitHubAppService.getInstallationService(job.repository.installation?.githubInstallationId.toString());
      const run = await startBehavioralRun(job, req.body ?? {}, gh);
      return res.status(202).json({ run: runDto(run) });
    } catch (err) { return failure(res, err); }
  }
  static async claim(req: Request, res: Response) {
    try {
      const { run, identity, config } = await ciContext(req);
      const gh = await GitHubAppService.getInstallationService(run.repository.installation!.githubInstallationId.toString());
      const preview = await trustedPreview(gh, run.repository.fullName, run.deploymentId, run.headSha, config);
      if (preview !== run.previewUrl) throw new BehavioralError(409, 'Preview metadata changed; create a new run');
      const claimed = await prisma.behavioralRun.updateMany({ where: { id: run.id, deadlineAt: { gt: new Date() }, OR: [{ status: 'QUEUED' }, { status: 'RUNNING', ciRunId: identity.runId }] }, data: { status: 'RUNNING', ciRunId: identity.runId, reason: null } });
      if (!claimed.count) throw new BehavioralError(409, 'Run is no longer claimable');
      return res.json({ plan: run.plan, previewUrl: run.previewUrl, limits: LIMITS, headSha: run.headSha });
    } catch (err) { return failure(res, err); }
  }
  static async finish(req: Request, res: Response) {
    try {
      const { run, identity } = await ciContext(req);
      const result = await completeBehavioralRun(run, identity.runId, req.body?.evidence);
      return res.json({ run: runDto(result!) });
    } catch (err) { return failure(res, err); }
  }
}
