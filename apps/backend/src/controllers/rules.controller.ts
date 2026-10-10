import { Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import prisma from '../config/prisma';
import { RulesService } from '../services/rules.service';
import { lockHistoricalRepository } from '../services/historical/state';
import { LoopError, requireRevision } from '../services/feedback-loop/workflow.service';

async function ownedRepository(tx: Prisma.TransactionClient, repoId: string, actorId: string) {
  const where = { id: repoId, userId: actorId, isActive: true };
  if (!await tx.repository.findFirst({ where })) throw new LoopError(404, 'Repository not found');
  await lockHistoricalRepository(tx, repoId);
  if (!await tx.repository.findFirst({ where })) throw new LoopError(404, 'Repository not found');
}
async function respond(res: Response, operation: () => Promise<unknown>, status = 200) {
  try { const result = await operation(); return res.status(status).json(result); }
  catch (err) {
    if (err instanceof LoopError) return res.status(err.status).json({ error: err.message });
    return res.status(503).json({ error: 'Rule operation unavailable; reload before retrying' });
  }
}
export class RulesController {
  static async list(req: Request, res: Response) {
    return respond(res, async () => {
      const repo = await prisma.repository.findFirst({ where: { id: String(req.params.repoId), userId: req.auth!.userId, isActive: true },
        select: { id: true, fullName: true } });
      if (!repo) throw new LoopError(404, 'Repository not found');
      const rules = await prisma.repositoryRule.findMany({ where: { repositoryId: repo.id }, orderBy: { createdAt: 'asc' }, take: 500 });
      return { rules, repository: repo };
    });
  }
  static async create(req: Request, res: Response) {
    return respond(res, () => prisma.$transaction(async tx => {
      const repositoryId = String(req.params.repoId), actorId = req.auth!.userId;
      await ownedRepository(tx, repositoryId, actorId);
      const parsed = RulesService.validateRule(req.body);
      if ('error' in parsed) throw new LoopError(400, parsed.error);
      if (await tx.repositoryRule.count({ where: { repositoryId } }) >= 500) throw new LoopError(409, 'Repository rule limit reached');
      const rule = await tx.repositoryRule.create({ data: { ...parsed.rule, repositoryId } });
      await tx.ruleAuditEvent.create({ data: { repositoryId, ruleId: rule.id, actorId, action: 'CREATED', revision: rule.revision } });
      return { rule };
    }), 201);
  }
  static async update(req: Request, res: Response) {
    return respond(res, () => prisma.$transaction(async tx => {
      const repositoryId = String(req.params.repoId), actorId = req.auth!.userId;
      await ownedRepository(tx, repositoryId, actorId);
      const rule = await tx.repositoryRule.findFirst({ where: { id: String(req.params.ruleId), repositoryId } });
      if (!rule) throw new LoopError(404, 'Rule not found');
      const revision = requireRevision(req.body?.expectedRevision);
      if (rule.revision !== revision) throw new LoopError(409, 'Rule changed; reload before retrying');
      const allowed = ['name', 'description', 'guideline', 'pattern', 'severity', 'category', 'enforcement', 'enabled'] as const;
      const merged = Object.fromEntries(allowed.map(k => [k, req.body?.[k] !== undefined ? req.body[k] : rule[k]]));
      const parsed = RulesService.validateRule(merged);
      if ('error' in parsed) throw new LoopError(400, parsed.error);
      if (rule.origin === 'FINDING' && (parsed.rule.enforcement !== 'LLM' || parsed.rule.pattern)) {
        throw new LoopError(400, 'Finding-derived rules support Model enforcement only');
      }
      const updated = await tx.repositoryRule.update({ where: { id: rule.id, revision }, data: { ...parsed.rule, revision: { increment: 1 } } });
      await tx.ruleAuditEvent.create({ data: { repositoryId, ruleId: rule.id, actorId, action: 'UPDATED', revision: updated.revision } });
      return { rule: updated };
    }));
  }
  static async remove(req: Request, res: Response) {
    return respond(res, () => prisma.$transaction(async tx => {
      const repositoryId = String(req.params.repoId), actorId = req.auth!.userId;
      await ownedRepository(tx, repositoryId, actorId);
      const rule = await tx.repositoryRule.findFirst({ where: { id: String(req.params.ruleId), repositoryId } });
      if (!rule) throw new LoopError(404, 'Rule not found');
      const revision = requireRevision(req.body?.expectedRevision);
      if (revision !== rule.revision) throw new LoopError(409, 'Rule changed; reload before deleting');
      await tx.ruleAuditEvent.create({ data: { repositoryId, ruleId: rule.id, actorId, action: 'DELETED', revision } });
      await tx.repositoryRule.delete({ where: { id: rule.id, revision } });
      return { status: 'OK' };
    }));
  }
}
