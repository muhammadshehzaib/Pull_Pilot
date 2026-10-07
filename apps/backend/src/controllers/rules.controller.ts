import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { RulesService } from '../services/rules.service';

/**
 * Resolves the repository a rule request targets, scoped to the authenticated
 * user. Anything else is a 404 rather than a 403: a caller who does not own
 * the repository should not be able to tell whether it exists.
 */
async function findOwnedRepository(repoId: string, userId: string) {
  return prisma.repository.findFirst({
    where: { id: repoId, userId },
    select: { id: true, fullName: true },
  });
}

async function findOwnedRule(repoId: string, ruleId: string, userId: string) {
  return prisma.repositoryRule.findFirst({
    where: { id: ruleId, repositoryId: repoId, repository: { userId } },
  });
}

export class RulesController {
  /** GET /api/repositories/:repoId/rules */
  static async list(req: Request, res: Response) {
    const repo = await findOwnedRepository(String(req.params.repoId), req.auth!.userId);
    if (!repo) return res.status(404).json({ error: 'Repository not found' });

    const rules = await prisma.repositoryRule.findMany({
      where: { repositoryId: repo.id },
      orderBy: { createdAt: 'asc' },
    });

    return res.json({ rules, repository: { id: repo.id, fullName: repo.fullName } });
  }

  /** POST /api/repositories/:repoId/rules */
  static async create(req: Request, res: Response) {
    const repo = await findOwnedRepository(String(req.params.repoId), req.auth!.userId);
    if (!repo) return res.status(404).json({ error: 'Repository not found' });

    const parsed = RulesService.validateRule(req.body);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });

    const rule = await prisma.repositoryRule.create({
      data: { ...parsed.rule, repositoryId: repo.id },
    });

    return res.status(201).json({ rule });
  }

  /**
   * PUT /api/repositories/:repoId/rules/:ruleId
   *
   * Full-document update: the body is merged over the stored rule and the
   * result is re-validated as a whole, so enforcement-specific requirements
   * (guideline vs. pattern) are checked against the merged state. A partial
   * body — such as `{ enabled: false }` from the toggle — therefore still
   * produces a valid rule.
   */
  static async update(req: Request, res: Response) {
    const rule = await findOwnedRule(String(req.params.repoId), String(req.params.ruleId), req.auth!.userId);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = {
      name: rule.name,
      description: rule.description,
      guideline: rule.guideline,
      pattern: rule.pattern,
      severity: rule.severity,
      category: rule.category,
      enforcement: rule.enforcement,
      enabled: rule.enabled,
    };
    for (const key of Object.keys(merged)) {
      if (body[key] !== undefined) merged[key] = body[key];
    }

    const parsed = RulesService.validateRule(merged);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });

    const updated = await prisma.repositoryRule.update({
      where: { id: rule.id },
      data: parsed.rule,
    });

    return res.json({ rule: updated });
  }

  /** DELETE /api/repositories/:repoId/rules/:ruleId */
  static async remove(req: Request, res: Response) {
    const rule = await findOwnedRule(String(req.params.repoId), String(req.params.ruleId), req.auth!.userId);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });

    await prisma.repositoryRule.delete({ where: { id: rule.id } });
    return res.json({ status: 'OK' });
  }
}
