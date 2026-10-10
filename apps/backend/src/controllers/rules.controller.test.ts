import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRepoFindFirst, mockRuleFindMany, mockRuleFindFirst, mockRuleCreate, mockRuleUpdate, mockRuleDelete } = vi.hoisted(() => ({
  mockRepoFindFirst: vi.fn(),
  mockRuleFindMany: vi.fn(),
  mockRuleFindFirst: vi.fn(),
  mockRuleCreate: vi.fn(),
  mockRuleUpdate: vi.fn(),
  mockRuleDelete: vi.fn(),
}));

vi.mock('../config/prisma', () => {
  const db: any = {
    $queryRaw: vi.fn(async () => [{ id: 'repo-1' }]),
    ruleAuditEvent: { create: vi.fn() },
    repository: { findFirst: mockRepoFindFirst },
    repositoryRule: {
      count: vi.fn(async () => 0),
      findMany: mockRuleFindMany,
      findFirst: mockRuleFindFirst,
      create: mockRuleCreate,
      update: mockRuleUpdate,
      delete: mockRuleDelete,
    },
  };
  db.$transaction = vi.fn(async (fn: any) => fn(db));
  return { default: db };
});

import { RulesController } from './rules.controller';
import { mockReq, mockRes } from '../test-utils/express-mocks';

const authedReq = (overrides: any = {}) => {
  const req = mockReq(overrides);
  (req as any).auth = { userId: 'u-1', githubId: 'gh' };
  return req;
};

const ownedRepo = { id: 'repo-1', fullName: 'octo/cat' };

const storedRule = {
  revision: 0,
  origin: 'MANUAL',
  id: 'rule-1',
  repositoryId: 'repo-1',
  name: 'No eval',
  description: 'eval() is forbidden',
  guideline: null,
  pattern: 'eval\\(',
  severity: 'HIGH',
  category: 'SECURITY',
  enforcement: 'DETERMINISTIC',
  enabled: true,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRepoFindFirst.mockResolvedValue(ownedRepo);
  mockRuleFindMany.mockResolvedValue([storedRule]);
  mockRuleFindFirst.mockResolvedValue(storedRule);
  mockRuleCreate.mockImplementation(async (args: any) => ({ id: 'rule-2', ...args.data }));
  mockRuleUpdate.mockImplementation(async (args: any) => ({ ...storedRule, ...args.data }));
  mockRuleDelete.mockResolvedValue(storedRule);
});

describe('RulesController.list', () => {
  it('returns the rules of an owned repository', async () => {
    const req = authedReq({ params: { repoId: 'repo-1' } });
    const res = mockRes();

    await RulesController.list(req, res);

    expect(mockRepoFindFirst).toHaveBeenCalledWith({
      where: { id: 'repo-1', userId: 'u-1', isActive: true },
      select: { id: true, fullName: true },
    });
    expect(mockRuleFindMany).toHaveBeenCalledWith({
      where: { repositoryId: 'repo-1' },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    expect(res.json).toHaveBeenCalledWith({
      rules: [storedRule],
      repository: { id: 'repo-1', fullName: 'octo/cat' },
    });
  });

  it('404s when the repository is not owned by the caller', async () => {
    mockRepoFindFirst.mockResolvedValueOnce(null);
    const req = authedReq({ params: { repoId: 'someone-elses' } });
    const res = mockRes();

    await RulesController.list(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockRuleFindMany).not.toHaveBeenCalled();
  });
});

describe('RulesController.create', () => {
  it('creates a validated rule and returns 201', async () => {
    const req = authedReq({
      params: { repoId: 'repo-1' },
      body: { name: 'No eval', enforcement: 'DETERMINISTIC', pattern: 'eval\\(', severity: 'HIGH' },
    });
    const res = mockRes();

    await RulesController.create(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockRuleCreate).toHaveBeenCalledWith({
      data: {
        name: 'No eval',
        description: null,
        guideline: null,
        pattern: 'eval\\(',
        severity: 'HIGH',
        category: 'MAINTAINABILITY',
        enforcement: 'DETERMINISTIC',
        enabled: true,
        repositoryId: 'repo-1',
      },
    });
  });

  it('400s on an invalid rule without touching the database', async () => {
    const req = authedReq({
      params: { repoId: 'repo-1' },
      body: { name: 'Broken', enforcement: 'DETERMINISTIC', pattern: '[unclosed' },
    });
    const res = mockRes();

    await RulesController.create(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('not a valid regular expression') });
    expect(mockRuleCreate).not.toHaveBeenCalled();
  });

  it('404s when the repository is not owned by the caller', async () => {
    mockRepoFindFirst.mockResolvedValueOnce(null);
    const req = authedReq({ params: { repoId: 'repo-x' }, body: { name: 'n', guideline: 'g' } });
    const res = mockRes();

    await RulesController.create(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockRuleCreate).not.toHaveBeenCalled();
  });
});

describe('RulesController.update', () => {
  it('merges a partial body over the stored rule before validating', async () => {
    const req = authedReq({
      params: { repoId: 'repo-1', ruleId: 'rule-1' },
      body: { enabled: false, expectedRevision: 0 },
    });
    const res = mockRes();

    await RulesController.update(req, res);

    expect(mockRuleFindFirst).toHaveBeenCalledWith({
      where: { id: 'rule-1', repositoryId: 'repo-1' },
    });
    expect(mockRuleUpdate).toHaveBeenCalledWith({
      where: { id: 'rule-1', revision: 0 },
      data: {
        name: 'No eval',
        description: 'eval() is forbidden',
        guideline: null,
        pattern: 'eval\\(',
        severity: 'HIGH',
        category: 'SECURITY',
        enforcement: 'DETERMINISTIC',
        enabled: false,
        revision: { increment: 1 },
      },
    });
    expect(res.json).toHaveBeenCalledWith({ rule: expect.objectContaining({ enabled: false }) });
  });

  it('400s when the merged rule is invalid (e.g. enforcement changed without a pattern)', async () => {
    const req = authedReq({
      params: { repoId: 'repo-1', ruleId: 'rule-1' },
      // Stored rule is DETERMINISTIC with a pattern; clearing both leaves an
      // unusable rule, which validation must catch.
      body: { pattern: null, enforcement: 'DETERMINISTIC', expectedRevision: 0 },
    });
    const res = mockRes();

    await RulesController.update(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockRuleUpdate).not.toHaveBeenCalled();
  });

  it('404s when the rule does not exist or belongs to another repository', async () => {
    mockRuleFindFirst.mockResolvedValueOnce(null);
    const req = authedReq({
      params: { repoId: 'repo-1', ruleId: 'rule-elsewhere' },
      body: { enabled: false },
    });
    const res = mockRes();

    await RulesController.update(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockRuleUpdate).not.toHaveBeenCalled();
  });
});

describe('RulesController.remove', () => {
  it('deletes an owned rule', async () => {
    const req = authedReq({ params: { repoId: 'repo-1', ruleId: 'rule-1' }, body: { expectedRevision: 0 } });
    const res = mockRes();

    await RulesController.remove(req, res);

    expect(mockRuleDelete).toHaveBeenCalledWith({ where: { id: 'rule-1', revision: 0 } });
    expect(res.json).toHaveBeenCalledWith({ status: 'OK' });
  });

  it('404s when the rule is not owned by the caller', async () => {
    mockRuleFindFirst.mockResolvedValueOnce(null);
    const req = authedReq({ params: { repoId: 'repo-1', ruleId: 'rule-x' } });
    const res = mockRes();

    await RulesController.remove(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockRuleDelete).not.toHaveBeenCalled();
  });
});

describe('Phase 9 rule integrity', () => {
  it('requires revisions for edits and rejects stale writes', async () => {
    const missing = mockRes();
    await RulesController.update(authedReq({ params: { repoId: 'repo-1', ruleId: 'rule-1' }, body: { enabled: false } }), missing);
    expect(missing.status).toHaveBeenLastCalledWith(400);
    const stale = mockRes();
    await RulesController.update(authedReq({ params: { repoId: 'repo-1', ruleId: 'rule-1' }, body: { expectedRevision: 99 } }), stale);
    expect(stale.status).toHaveBeenLastCalledWith(409);
    expect(mockRuleUpdate).not.toHaveBeenCalled();
  });
  it('does not allow finding-derived rules to become executable patterns', async () => {
    mockRuleFindFirst.mockResolvedValueOnce({ ...storedRule, origin: 'FINDING' });
    const res = mockRes();
    await RulesController.update(authedReq({ params: { repoId: 'repo-1', ruleId: 'rule-1' }, body: { expectedRevision: 0 } }), res);
    expect(res.status).toHaveBeenLastCalledWith(400);
    expect(mockRuleUpdate).not.toHaveBeenCalled();
  });
  it('returns a sanitized error on database failure', async () => {
    mockRepoFindFirst.mockRejectedValueOnce(new Error('sensitive database details'));
    const res = mockRes(); await RulesController.list(authedReq({ params: { repoId: 'repo-1' } }), res);
    expect(res.status).toHaveBeenLastCalledWith(503);
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('sensitive');
  });
});
