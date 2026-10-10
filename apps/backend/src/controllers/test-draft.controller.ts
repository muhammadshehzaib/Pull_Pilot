import { Request, Response } from 'express';
import { TestDraftStatus, type TestDraft } from '@prisma/client';
import prisma from '../config/prisma';
import { EncryptionService } from '../services/encryption.service';
import { GitHubAppService } from '../services/github-app.service';
import { AiProviderFactory } from '../services/ai/ai-factory';
import { generateTestDraftForScenario } from '../services/test-gap/draft-generation.service';
import {
  createTestPullRequest,
  TestPrError,
} from '../services/test-gap/test-pr.service';
import { validateProposedTestPath, validateDraftContent } from '../services/test-gap/draft-validation';
import { isInsufficient } from '../services/test-gap/test-draft-types';
import type { TestGapConfidence, TestGapScenario } from '../services/test-gap/test-gap-types';

const CONFIDENCES: TestGapConfidence[] = ['HIGH', 'MEDIUM', 'LOW'];

/** Validates a scenario echoed back by the client before it is trusted. */
export function parseScenarioInput(value: unknown): TestGapScenario | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;

  const filePath = firstString(obj.filePath, obj.file, obj.path);
  const scenario = firstString(obj.scenario, obj.test, obj.description, obj.title);
  if (!filePath || !scenario) return null;

  const rawConfidence = String(obj.confidence ?? '').toUpperCase();
  const confidence = (CONFIDENCES as string[]).includes(rawConfidence)
    ? (rawConfidence as TestGapConfidence)
    : 'MEDIUM';

  const lineNumber =
    typeof obj.lineNumber === 'number' && Number.isFinite(obj.lineNumber) && obj.lineNumber > 0
      ? Math.floor(obj.lineNumber)
      : 1;
  const edgeCase = firstString(obj.edgeCase);

  return {
    filePath,
    scenario,
    expected: firstString(obj.expected, obj.assertion) || scenario,
    lineNumber,
    ...(edgeCase ? { edgeCase } : {}),
    confidence,
  };
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return '';
}

/** The draft shape returned to the client. Internal fields stay server-side. */
export function toTestDraftDto(draft: TestDraft) {
  return {
    id: draft.id,
    repositoryId: draft.repositoryId,
    analysisJobId: draft.analysisJobId,
    scenario: draft.scenario,
    sourcePath: draft.sourcePath,
    targetPath: draft.targetPath,
    targetContent: draft.targetContent,
    framework: draft.framework,
    notes: draft.notes,
    structuralNote: draft.structuralNote,
    baseBranch: draft.baseBranch,
    baseSha: draft.baseSha,
    sourcePrNumber: draft.sourcePrNumber,
    status: draft.status,
    branchName: draft.branchName,
    commitSha: draft.commitSha,
    prNumber: draft.prNumber,
    prUrl: draft.prUrl,
    error: draft.error,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

async function findOwnedDraft(id: string, userId: string) {
  return prisma.testDraft.findFirst({
    where: { id, repository: { userId } },
    include: { repository: { include: { installation: true } } },
  });
}

export class TestDraftController {
  /** POST /api/test-drafts — generate a draft for one scenario. */
  static async create(req: Request, res: Response) {
    const { jobId, scenario } = (req.body ?? {}) as Record<string, unknown>;

    if (typeof jobId !== 'string' || jobId.length === 0) {
      return res.status(400).json({ error: 'jobId is required' });
    }
    const parsedScenario = parseScenarioInput(scenario);
    if (!parsedScenario) {
      return res.status(400).json({ error: 'A valid scenario (with filePath and scenario) is required' });
    }

    const job = await prisma.analysisJob.findFirst({
      where: { id: jobId, repository: { userId: req.auth!.userId } },
      include: { repository: { include: { installation: true } } },
    });
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const repo = job.repository;
    const vault = await prisma.vault.findUnique({ where: { userId: req.auth!.userId } });
    if (!vault) {
      return res.status(400).json({ error: 'No AI API key found. Save one in the API Key Vault first.' });
    }

    const rawApiKey = EncryptionService.decrypt(
      vault.encryptedGeminiKey,
      vault.iv,
      vault.authTag,
      vault.salt,
    );
    const provider = AiProviderFactory.getProvider(vault.provider, rawApiKey);

    const [owner, repoName] = repo.fullName.split('/');
    const ghService = await GitHubAppService.getInstallationService(
      repo.installation?.githubInstallationId?.toString(),
    );

    // Resolve the exact commit the draft should be written against, plus the
    // base branch/SHA the PR will later target.
    let ref: string;
    let baseBranch: string;
    let baseSha: string;
    let sourcePrNumber: number | null = null;
    try {
      if (job.eventType === 'PULL_REQUEST') {
        const pr = await ghService.getPullRequest(owner, repoName, Number(job.referenceId));
        ref = pr.head.sha;
        baseBranch = pr.base.ref;
        baseSha = pr.base.sha;
        sourcePrNumber = Number(job.referenceId);
      } else {
        ref = job.referenceId;
        baseBranch = repo.defaultBranch || (await ghService.getRepo(owner, repoName)).default_branch || 'main';
        baseSha = (await ghService.getBranchHeadSha(owner, repoName, baseBranch)) || ref;
      }
    } catch (err) {
      return res.status(502).json({ error: `Could not resolve the base branch from GitHub: ${(err as Error).message}` });
    }

    let generated;
    try {
      generated = await generateTestDraftForScenario({
        ghService,
        owner,
        repo: repoName,
        ref,
        sourcePath: parsedScenario.filePath,
        scenario: parsedScenario,
        provider,
      });
    } catch (err) {
      return res.status(502).json({ error: `Test drafting failed: ${(err as Error).message}` });
    }

    if (!generated) {
      return res
        .status(422)
        .json({ error: 'No code under test was found for that path, so a draft cannot be grounded.' });
    }
    if (isInsufficient(generated)) {
      return res.json({ draft: null, insufficient: true, reason: generated.reason });
    }

    const pathCheck = validateProposedTestPath(generated.targetPath);
    if (!pathCheck.ok) {
      return res.status(422).json({ error: `The proposed test path was rejected: ${pathCheck.reason}` });
    }
    const contentCheck = validateDraftContent(generated.content);
    if (!contentCheck.ok) {
      return res.status(422).json({ error: `The draft was rejected: ${contentCheck.reason}` });
    }

    const draft = await prisma.testDraft.create({
      data: {
        repositoryId: repo.id,
        analysisJobId: job.id,
        userId: req.auth!.userId,
        scenario: parsedScenario as any,
        sourcePath: parsedScenario.filePath,
        targetPath: pathCheck.path!,
        targetContent: generated.content,
        framework: generated.framework ?? null,
        notes: generated.notes ?? null,
        structuralNote: contentCheck.note ?? null,
        baseBranch,
        baseSha,
        sourcePrNumber,
        status: TestDraftStatus.DRAFT,
      },
    });

    return res.status(201).json({ draft: toTestDraftDto(draft), insufficient: false });
  }

  /** GET /api/test-drafts/:id */
  static async get(req: Request, res: Response) {
    const draft = await findOwnedDraft(String(req.params.id), req.auth!.userId);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    return res.json({ draft: toTestDraftDto(draft) });
  }

  /** PUT /api/test-drafts/:id — edit an accepted-or-not draft before any write. */
  static async update(req: Request, res: Response) {
    const draft = await findOwnedDraft(String(req.params.id), req.auth!.userId);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    if (draft.status !== TestDraftStatus.DRAFT) {
      return res.status(409).json({ error: 'Only a pending draft can be edited.' });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const targetPath = body.targetPath === undefined ? draft.targetPath : String(body.targetPath);
    const targetContent =
      body.targetContent === undefined ? draft.targetContent : String(body.targetContent);

    const pathCheck = validateProposedTestPath(targetPath);
    if (!pathCheck.ok) return res.status(400).json({ error: pathCheck.reason });
    const contentCheck = validateDraftContent(targetContent);
    if (!contentCheck.ok) return res.status(400).json({ error: contentCheck.reason });

    const updated = await prisma.testDraft.update({
      where: { id: draft.id },
      data: {
        targetPath: pathCheck.path!,
        targetContent,
        structuralNote: contentCheck.note ?? null,
      },
    });

    return res.json({ draft: toTestDraftDto(updated) });
  }

  /** DELETE /api/test-drafts/:id — discard, keeping the row for a clean trail. */
  static async discard(req: Request, res: Response) {
    const draft = await findOwnedDraft(String(req.params.id), req.auth!.userId);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    if (draft.status === TestDraftStatus.PR_CREATED) {
      return res.status(409).json({ error: 'A PR has already been created for this draft.' });
    }
    await prisma.testDraft.update({ where: { id: draft.id }, data: { status: TestDraftStatus.DISCARDED } });
    return res.json({ status: 'DISCARDED', id: draft.id });
  }

  /** GET /api/jobs/:id/test-drafts — drafts belonging to one review. */
  static async listForJob(req: Request, res: Response) {
    const job = await prisma.analysisJob.findFirst({
      where: { id: String(req.params.id), repository: { userId: req.auth!.userId } },
      select: { id: true },
    });
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const drafts = await prisma.testDraft.findMany({
      where: { analysisJobId: job.id, repository: { userId: req.auth!.userId } },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ drafts: drafts.map(toTestDraftDto) });
  }

  /** POST /api/test-drafts/:id/create-pr — the only GitHub write in Phase 5. */
  static async createPr(req: Request, res: Response) {
    const draft = await findOwnedDraft(String(req.params.id), req.auth!.userId);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });

    // Idempotent: a repeat of an already-successful request returns the PR.
    if (draft.status === TestDraftStatus.PR_CREATED) {
      return res.json({ draft: toTestDraftDto(draft), reused: true });
    }
    if (draft.status === TestDraftStatus.DISCARDED) {
      return res.status(409).json({ error: 'This draft was discarded.' });
    }

    const confirmed = (req.body ?? {}).confirmed === true;
    const repo = draft.repository;
    const [owner, repoName] = repo.fullName.split('/');
    const ghService = await GitHubAppService.getInstallationService(
      repo.installation?.githubInstallationId?.toString(),
    );

    const scenario = (draft.scenario ?? {}) as Record<string, unknown>;

    try {
      const result = await createTestPullRequest({
        ghService,
        owner,
        repo: repoName,
        confirmed,
        draft: {
          id: draft.id,
          targetPath: draft.targetPath,
          targetContent: draft.targetContent,
          sourcePath: draft.sourcePath,
          baseBranch: draft.baseBranch,
          baseSha: draft.baseSha,
          sourcePrNumber: draft.sourcePrNumber,
          scenarioLabel: typeof scenario.scenario === 'string' ? scenario.scenario : undefined,
        },
      });

      const updated = await prisma.testDraft.update({
        where: { id: draft.id },
        data: {
          status: TestDraftStatus.PR_CREATED,
          branchName: result.branchName,
          commitSha: result.commitSha,
          prNumber: result.prNumber,
          prUrl: result.prUrl,
          error: null,
        },
      });

      return res.json({ draft: toTestDraftDto(updated), reused: result.reused });
    } catch (err) {
      if (err instanceof TestPrError) {
        const status =
          err.code === 'confirmation-required'
            ? 400
            : err.code === 'stale-base' || err.code === 'base-branch-missing' || err.code === 'write-disabled'
              ? 409
              : 502;
        // Keep the draft (and record why) so the developer can retry without
        // regenerating. Confirmation is a client mistake, not a draft failure.
        if (err.code !== 'confirmation-required') {
          await prisma.testDraft
            .update({ where: { id: draft.id }, data: { error: err.message } })
            .catch(() => {});
        }
        return res.status(status).json({ error: err.message, code: err.code });
      }
      return res.status(502).json({ error: (err as Error).message });
    }
  }
}
