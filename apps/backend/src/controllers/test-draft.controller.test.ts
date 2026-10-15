import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockJobFindFirst,
  mockVaultFindUnique,
  mockDraftCreate,
  mockDraftFindFirst,
  mockDraftUpdate,
  mockDraftFindMany,
  mockDecrypt,
  mockGetInstallationService,
  mockGetProvider,
  mockGenerate,
} = vi.hoisted(() => ({
  mockJobFindFirst: vi.fn(),
  mockVaultFindUnique: vi.fn(),
  mockDraftCreate: vi.fn(),
  mockDraftFindFirst: vi.fn(),
  mockDraftUpdate: vi.fn(),
  mockDraftFindMany: vi.fn(),
  mockDecrypt: vi.fn(() => 'plain-key'),
  mockGetInstallationService: vi.fn(),
  mockGetProvider: vi.fn(() => ({})),
  mockGenerate: vi.fn(),
}));

vi.mock('../config/prisma', () => ({
  default: {
    analysisJob: { findFirst: mockJobFindFirst },
    vault: { findUnique: mockVaultFindUnique },
    testDraft: {
      create: mockDraftCreate,
      findFirst: mockDraftFindFirst,
      update: mockDraftUpdate,
      findMany: mockDraftFindMany,
    },
  },
}));

vi.mock('../services/encryption.service', () => ({
  EncryptionService: { decrypt: mockDecrypt },
}));

vi.mock('../services/github-app.service', () => ({
  GitHubAppService: { getInstallationService: mockGetInstallationService },
}));

vi.mock('../services/ai/ai-factory', () => ({
  AiProviderFactory: { getProvider: mockGetProvider },
}));

vi.mock('../services/test-gap/draft-generation.service', () => ({
  generateTestDraftForScenario: mockGenerate,
}));

import { TestDraftController, parseScenarioInput } from './test-draft.controller';
import { mockReq, mockRes } from '../test-utils/express-mocks';

const authedReq = (overrides: any = {}) => {
  const req = mockReq(overrides);
  (req as any).auth = { userId: 'u-1', githubId: 'gh' };
  return req;
};

const scenario = {
  filePath: 'src/a.ts',
  lineNumber: 3,
  scenario: 'handles empty input',
  expected: 'throws',
  confidence: 'HIGH',
};

function makeGh() {
  return {
    getPullRequest: vi.fn(async () => ({ head: { sha: 'head-sha' }, base: { ref: 'main', sha: 'base-sha' } })),
    getRepo: vi.fn(async () => ({ default_branch: 'main' })),
    getBranchHeadSha: vi.fn(async (_o: string, _r: string, branch: string) =>
      branch === 'main' ? 'base-sha' : null,
    ),
    createBranch: vi.fn(async () => {}),
    getFileContent: vi.fn(async () => null),
    upsertFile: vi.fn(async () => 'commit-9'),
    findPullRequestByHead: vi.fn(async () => null),
    createPullRequest: vi.fn(async () => ({ number: 11, htmlUrl: 'https://gh/pr/11' })),
  };
}

const ownedJob = {
  id: 'job-1',
  eventType: 'PULL_REQUEST',
  referenceId: '42',
  results: {
    includedFiles: ['src/a.ts'],
    testGaps: {
      scenarios: [scenario],
      evidence: { changedSources: ['src/a.ts'], relatedTests: [], treeTruncated: false, incomplete: false },
      analyzed: true,
    },
  },
  repository: {
    id: 'repo-1',
    fullName: 'octo/cat',
    defaultBranch: 'main',
    installation: { githubInstallationId: 123n },
  },
};

const vault = { provider: 'GEMINI', encryptedGeminiKey: 'x', iv: 'i', authTag: 't', salt: 's' };

const draftRow: any = {
  id: 'draft-1',
  repositoryId: 'repo-1',
  analysisJobId: 'job-1',
  userId: 'u-1',
  scenario,
  sourcePath: 'src/a.ts',
  targetPath: 'tests/a.test.ts',
  targetContent: 'it("x", () => {})',
  framework: 'vitest',
  notes: null,
  structuralNote: null,
  baseBranch: 'main',
  baseSha: 'base-sha',
  sourceHeadSha: 'head-sha',
  sourcePrNumber: 42,
  status: 'DRAFT',
  branchName: null,
  commitSha: null,
  prNumber: null,
  prUrl: null,
  error: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  repository: {
    id: 'repo-1',
    fullName: 'octo/cat',
    installation: { githubInstallationId: 123n },
  },
};

function ghMock() {
  return {
    getPullRequest: vi.fn(async () => ({ head: { sha: 'head-sha' }, base: { ref: 'main', sha: 'base-sha' } })),
    getRepo: vi.fn(async () => ({ default_branch: 'main' })),
    getBranchHeadSha: vi.fn(async () => 'base-sha'),
    createBranch: vi.fn(async () => {}),
    getFileContent: vi.fn(async () => null),
    upsertFile: vi.fn(async () => 'commit-1'),
    findPullRequestByHead: vi.fn(async () => null),
    createPullRequest: vi.fn(async () => ({ number: 7, htmlUrl: 'https://gh/pr/7' })),
  };
}

let ghMockObj: ReturnType<typeof gh>;

beforeEach(() => {
  vi.clearAllMocks();
  mockJobFindFirst.mockResolvedValue(ownedJob);
  mockVaultFindUnique.mockResolvedValue(vault);
  mockDraftFindFirst.mockResolvedValue(draftRow);
  mockDraftCreate.mockImplementation(async (args: any) => ({ ...draftRow, ...args.data, id: 'draft-new' }));
  mockDraftUpdate.mockImplementation(async (args: any) => ({ ...draftRow, ...args.data }));
  mockDraftFindMany.mockResolvedValue([draftRow]);
  mockGenerate.mockResolvedValue({ targetPath: 'tests/a.test.ts', content: 'it("x", () => {})' });
  mockGetProvider.mockReturnValue({});
  mockGetInstallationService.mockImplementation(async () => makeGh());
});

describe('parseScenarioInput', () => {
  it('accepts a valid scenario and defaults confidence', () => {
    const parsed = parseScenarioInput({ filePath: 'src/a.ts', scenario: 's' });
    expect(parsed).toMatchObject({ filePath: 'src/a.ts', scenario: 's', confidence: 'MEDIUM' });
  });

  it('rejects a scenario without a path or description', () => {
    expect(parseScenarioInput({ scenario: 's' })).toBeNull();
    expect(parseScenarioInput({ filePath: 'src/a.ts' })).toBeNull();
    expect(parseScenarioInput(null)).toBeNull();
  });
});

describe('TestDraftController.create', () => {
  it('404s when the job is not owned by the caller (tenant isolation)', async () => {
    mockJobFindFirst.mockResolvedValueOnce(null);
    const req = authedReq({ body: { jobId: 'job-x', scenario } });
    const res = mockRes();

    await TestDraftController.create(req, res);

    expect(mockJobFindFirst).toHaveBeenCalledWith({
      where: { id: 'job-x', repository: { userId: 'u-1' } },
      include: { repository: { include: { installation: true } } },
    });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockDraftCreate).not.toHaveBeenCalled();
  });

  it('400s when there is no vault', async () => {
    mockVaultFindUnique.mockResolvedValueOnce(null);
    const res = mockRes();
    await TestDraftController.create(authedReq({ body: { jobId: 'job-1', scenario } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('persists a validated draft and returns 201', async () => {
    const res = mockRes();
    await TestDraftController.create(authedReq({ body: { jobId: 'job-1', scenario } }), res);

    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePath: 'src/a.ts', ref: 'head-sha' }),
    );
    expect(mockDraftCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        repositoryId: 'repo-1',
        analysisJobId: 'job-1',
        userId: 'u-1',
        sourcePath: 'src/a.ts',
        targetPath: 'tests/a.test.ts',
        baseBranch: 'main',
        baseSha: 'base-sha',
        sourceHeadSha: 'head-sha',
        sourcePrNumber: 42,
        status: 'DRAFT',
      }),
    });
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('rejects a scenario not present in this review before calling the provider', async () => {
    const res = mockRes();
    await TestDraftController.create(
      authedReq({ body: { jobId: 'job-1', scenario: { ...scenario, filePath: 'src/other.ts' } } }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockDraftCreate).not.toHaveBeenCalled();
  });

  it('returns an insufficiency explanation without persisting', async () => {
    mockGenerate.mockResolvedValueOnce({ insufficient: true, reason: 'no fixtures found' });
    const res = mockRes();
    await TestDraftController.create(authedReq({ body: { jobId: 'job-1', scenario } }), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ draft: null, insufficient: true, reason: 'no fixtures found' }),
    );
    expect(mockDraftCreate).not.toHaveBeenCalled();
  });

  it('rejects an unsafe proposed path with 422 and does not persist', async () => {
    mockGenerate.mockResolvedValueOnce({ targetPath: '../../evil.test.ts', content: 'x' });
    const res = mockRes();
    await TestDraftController.create(authedReq({ body: { jobId: 'job-1', scenario } }), res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(mockDraftCreate).not.toHaveBeenCalled();
  });
});

describe('TestDraftController.get / listForJob', () => {
  it('404s reading another tenant draft', async () => {
    mockDraftFindFirst.mockResolvedValueOnce(null);
    const res = mockRes();
    await TestDraftController.get(authedReq({ params: { id: 'draft-x' } }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('lists drafts for an owned job only', async () => {
    const res = mockRes();
    await TestDraftController.listForJob(authedReq({ params: { id: 'job-1' } }), res);
    expect(mockDraftFindMany).toHaveBeenCalledWith({
      where: { analysisJobId: 'job-1', repository: { userId: 'u-1' } },
      orderBy: { createdAt: 'desc' },
    });
    expect(res.json).toHaveBeenCalled();
  });

  it('404s listing drafts for a job the caller does not own', async () => {
    mockJobFindFirst.mockResolvedValueOnce(null);
    const res = mockRes();
    await TestDraftController.listForJob(authedReq({ params: { id: 'job-x' } }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('TestDraftController.update / discard', () => {
  it('rejects an edit to a non-pending draft', async () => {
    mockDraftFindFirst.mockResolvedValueOnce({ ...draftRow, status: 'PR_CREATED' });
    const res = mockRes();
    await TestDraftController.update(authedReq({ params: { id: 'draft-1' }, body: {} }), res);
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('rejects an edit with an unsafe path', async () => {
    const res = mockRes();
    await TestDraftController.update(
      authedReq({ params: { id: 'draft-1' }, body: { targetPath: '/etc/foo.test.ts' } }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockDraftUpdate).not.toHaveBeenCalled();
  });

  it('saves a valid edit', async () => {
    const res = mockRes();
    await TestDraftController.update(
      authedReq({ params: { id: 'draft-1' }, body: { targetContent: 'it("new", () => {})' } }),
      res,
    );
    expect(mockDraftUpdate).toHaveBeenCalledWith({
      where: { id: 'draft-1' },
      data: expect.objectContaining({ targetContent: 'it("new", () => {})' }),
    });
    expect(res.json).toHaveBeenCalled();
  });

  it('marks a pending draft discarded', async () => {
    const res = mockRes();
    await TestDraftController.discard(authedReq({ params: { id: 'draft-1' } }), res);
    expect(mockDraftUpdate).toHaveBeenCalledWith({
      where: { id: 'draft-1' },
      data: { status: 'DISCARDED' },
    });
  });

  it('refuses to discard a draft that already opened a PR', async () => {
    mockDraftFindFirst.mockResolvedValueOnce({ ...draftRow, status: 'PR_CREATED' });
    const res = mockRes();
    await TestDraftController.discard(authedReq({ params: { id: 'draft-1' } }), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockDraftUpdate).not.toHaveBeenCalled();
  });
});

describe('TestDraftController.createPr', () => {
  it.each([{}, { confirmed: true }, { confirmed: true, isolated: true, sandboxPassed: true }])(
    'never creates a GitHub branch or changes a draft from client confirmation: %j', async body => {
      const res = mockRes();
      await TestDraftController.createPr(authedReq({ params: { id: 'draft-1' }, body }), res);
      expect(res.status).toHaveBeenCalledWith(body.confirmed ? 409 : 400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: body.confirmed ? 'write-disabled' : 'confirmation-required' }));
      expect(mockGetInstallationService).not.toHaveBeenCalled();
      expect(mockDraftUpdate).not.toHaveBeenCalled();
    },
  );

  it('keeps existing PR records readable without any GitHub writes', async () => {
    mockDraftFindFirst.mockResolvedValueOnce({ ...draftRow, status: 'PR_CREATED', prNumber: 11, prUrl: 'https://gh/pr/11' });
    const res = mockRes();
    await TestDraftController.createPr(authedReq({ params: { id: 'draft-1' }, body: { confirmed: true } }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ reused: true }));
    expect(mockGetInstallationService).not.toHaveBeenCalled();
  });

  it('rejects foreign drafts before revealing publication state', async () => {
    mockDraftFindFirst.mockResolvedValueOnce(null);
    const res = mockRes();
    await TestDraftController.createPr(authedReq({ params: { id: 'foreign' }, body: { confirmed: true } }), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockGetInstallationService).not.toHaveBeenCalled();
    expect(mockDraftUpdate).not.toHaveBeenCalled();
  });
});
