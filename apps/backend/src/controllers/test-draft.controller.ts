import { Request, Response } from 'express';
import { TestDraftStatus, type TestDraft } from '@prisma/client';
import prisma from '../config/prisma';
import { EncryptionService } from '../services/encryption.service';
import { GitHubAppService } from '../services/github-app.service';
import { AiProviderFactory } from '../services/ai/ai-factory';
import { generateTestDraftForScenario } from '../services/test-gap/draft-generation.service';
import { TEST_DRAFT_PUBLICATION_BLOCKED_REASON } from '../services/test-gap/test-pr.service';
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
    sourceHeadSha: draft.sourceHeadSha,
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

    // A client may request a draft only for a scenario actually emitted for
    // this review, and only for one of the changed source files we reviewed.
    // Use the stored scenario as the canonical value; never trust the echoed
    // request body to choose an arbitrary file or rewrite the expected case.
    const results = job.results && typeof job.results === 'object' && !Array.isArray(job.results)
      ? (job.results as Record<string, unknown>)
      : {};
    const testGaps = results.testGaps && typeof results.testGaps === 'object' && !Array.isArray(results.testGaps)
      ? (results.testGaps as Record<string, unknown>)
      : {};
    const scenarios = Array.isArray(testGaps.scenarios) ? testGaps.scenarios : [];
    const storedScenario = scenarios.find((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const candidate = item as Record<string, unknown>;
      return candidate.filePath === parsedScenario.filePath &&
        candidate.scenario === parsedScenario.scenario &&
        candidate.lineNumber === parsedScenario.lineNumber;
    });
    const includedFiles = Array.isArray(results.includedFiles)
      ? results.includedFiles.filter((path): path is string => typeof path === 'string')
      : [];
    if (!storedScenario || !includedFiles.includes(parsedScenario.filePath)) {
      return res.status(400).json({ error: 'The selected scenario is not part of this review or its changed source files.' });
    }
    const canonicalScenario = parseScenarioInput(storedScenario);
    if (!canonicalScenario) {
      return res.status(400).json({ error: 'The stored test-gap scenario is invalid.' });
    }

    const repo = job.repository;
    const vault = await prisma.vault.findUnique({ where: { userId: req.auth!.userId } });
    if (!vault) {
      return res.status(400).json({ error: 'No AI API key found. Save one in the API Key Vault first.' });
    }

    const rawApiKey = await EncryptionService.decrypt(
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
    let sourceHeadSha: string | null = null;
    let sourcePrNumber: number | null = null;
    try {
      if (job.eventType === 'PULL_REQUEST') {
        const pr = await ghService.getPullRequest(owner, repoName, Number(job.referenceId));
        ref = pr.head.sha;
        sourceHeadSha = pr.head.sha;
        baseBranch = pr.base.ref;
        // The PR's recorded base.sha can lag behind its target branch when the
        // PR is behind. Snapshot the current target ref now; create-pr will
        // require this exact SHA to remain current before writing anything.
        const currentBaseSha = await ghService.getBranchHeadSha(owner, repoName, baseBranch);
        if (!currentBaseSha) throw new Error(`Base branch "${baseBranch}" has no current head.`);
        baseSha = currentBaseSha;
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
        scenario: canonicalScenario,
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
        scenario: canonicalScenario as any,
        sourcePath: canonicalScenario.filePath,
        targetPath: pathCheck.path!,
        targetContent: generated.content,
        framework: generated.framework ?? null,
        notes: generated.notes ?? null,
        structuralNote: contentCheck.note ?? null,
        baseBranch,
        baseSha,
        sourceHeadSha,
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

  /** POST /api/test-drafts/:id/create-pr — publication is blocked until execution is isolated. */
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

    if ((req.body ?? {}).confirmed !== true) {
      return res.status(400).json({ error: 'Creating a test PR requires explicit confirmation.', code: 'confirmation-required' });
    }
    // Refuse before acquiring a token or performing any GitHub writes.
    return res.status(409).json({ error: TEST_DRAFT_PUBLICATION_BLOCKED_REASON, code: 'write-disabled' });
  }
}
