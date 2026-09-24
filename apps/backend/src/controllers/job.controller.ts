import { Request, Response } from 'express';
import prisma from '../config/prisma';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

export class JobController {
  /**
   * Lists past analysis jobs for the authenticated user's repos.
   * Supports ?limit= and ?repositoryId= filtering. Returns lightweight
   * rows (no findings) — use the detail endpoint to fetch the full
   * results JSON.
   */
  static async list(req: Request, res: Response) {
    const limit = Math.min(
      Math.max(parseInt((req.query.limit as string) || `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );
    const repositoryId = (req.query.repositoryId as string) || undefined;

    const jobs = await prisma.analysisJob.findMany({
      where: {
        repository: { userId: req.auth!.userId },
        ...(repositoryId ? { repositoryId } : {}),
      },
      include: {
        repository: { select: { id: true, fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return res.json({
      jobs: jobs.map((j) => ({
        id: j.id,
        eventType: j.eventType,
        referenceId: j.referenceId,
        status: j.status,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
        repository: j.repository,
        findingCount: Array.isArray(j.results)
          ? j.results.length
          : j.results && typeof j.results === 'object' && Array.isArray((j.results as any).suggestions)
            ? (j.results as any).suggestions.length
            : 0,
      })),
    });
  }

  static async get(req: Request, res: Response) {
    const job = await prisma.analysisJob.findFirst({
      where: {
        id: String(req.params.id),
        repository: { userId: req.auth!.userId },
      },
      include: { repository: { select: { id: true, fullName: true } } },
    });

    if (!job) return res.status(404).json({ error: 'Job not found' });
    return res.json({ job });
  }
}
