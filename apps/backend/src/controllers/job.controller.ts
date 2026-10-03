import { Request, Response } from 'express';
import prisma from '../config/prisma';
import { AiSuggestion, normalizeSuggestions } from '../services/ai/finding-taxonomy';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

export type { AiSuggestion };

export function extractNormalizedFindings(results: unknown): AiSuggestion[] {
  if (!results || typeof results !== 'object') return [];
  if (Array.isArray(results)) {
    return normalizeSuggestions(results);
  }
  const obj = results as Record<string, unknown>;
  if (Array.isArray(obj.suggestions)) {
    return normalizeSuggestions(obj.suggestions);
  }
  return [];
}

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
        findingCount: extractNormalizedFindings(j.results).length,
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

    const normalizedFindings = extractNormalizedFindings(job.results);
    const rawObj = (job.results && typeof job.results === 'object' && !Array.isArray(job.results))
      ? (job.results as Record<string, unknown>)
      : {};

    return res.json({
      job: {
        ...job,
        results: normalizedFindings,
        metadata: {
          ignoredFiles: Array.isArray(rawObj.ignoredFiles) ? (rawObj.ignoredFiles as string[]) : [],
          includedFiles: Array.isArray(rawObj.includedFiles) ? (rawObj.includedFiles as string[]) : [],
          error: typeof rawObj.error === 'string' ? rawObj.error : undefined,
        },
      },
    });
  }
}
