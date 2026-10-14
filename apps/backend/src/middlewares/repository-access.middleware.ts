import type { Request, Response, NextFunction } from 'express';
import prisma from '../config/prisma';
import { GitHubAppService } from '../services/github-app.service';
import { RepositoryAccessError } from '../errors/repository-access.error';

type Resource = 'repository' | 'job' | 'draft';

/** Resolve ownership first; foreign IDs must never cause privileged GitHub calls. */
export function requireRepositoryAccess(resource: Resource, parameter: string, fromBody = false) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const id = fromBody ? req.body?.[parameter] : req.params[parameter];
    if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'A resource ID is required' });
    if (!req.auth) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const include = { installation: true } as const;
      const ownership = { userId: req.auth.userId };
      const repository = resource === 'repository'
        ? await prisma.repository.findFirst({ where: { id, ...ownership }, include })
        : resource === 'job'
          ? (await prisma.analysisJob.findFirst({ where: { id, repository: ownership },
              select: { repository: { include } } }))?.repository
          : (await prisma.testDraft.findFirst({ where: { id, repository: ownership },
              select: { repository: { include } } }))?.repository;
      if (!repository) return res.status(404).json({ error: 'Resource not found' });
      if (repository.installation && repository.installation.userId !== req.auth.userId) {
        throw new RepositoryAccessError();
      }
      const gh = await GitHubAppService.getInstallationService(repository.installation?.githubInstallationId.toString());
      const [owner, name] = repository.fullName.split('/');
      await gh.getRepoForUser(owner, name, req.auth.githubId, {
        expectedRepoId: repository.githubRepoId.toString(),
        requireMembership: repository.isPrivate,
      });
    } catch (error) {
      const accessError = error instanceof RepositoryAccessError ? error : new RepositoryAccessError(503);
      return res.status(accessError.status).json({ error: accessError.message });
    }
    return next();
  };
}
