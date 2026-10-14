import { beforeEach, describe, expect, it, vi } from 'vitest';
const { repositoryFind, jobFind, draftFind, getService, verify } = vi.hoisted(() => ({
  repositoryFind: vi.fn(), jobFind: vi.fn(), draftFind: vi.fn(), getService: vi.fn(), verify: vi.fn(),
}));
vi.mock('../config/prisma', () => ({ default: {
  repository: { findFirst: repositoryFind }, analysisJob: { findFirst: jobFind }, testDraft: { findFirst: draftFind },
} }));
vi.mock('../services/github-app.service', () => ({ GitHubAppService: { getInstallationService: getService } }));
import { requireRepositoryAccess } from './repository-access.middleware';
import { RepositoryAccessError } from '../errors/repository-access.error';
import { mockReq, mockRes, mockNext } from '../test-utils/express-mocks';

const repository = { fullName: 'company/private', githubRepoId: BigInt(99), isPrivate: true, installation: null };
beforeEach(() => {
  vi.resetAllMocks();
  repositoryFind.mockResolvedValue(repository);
  jobFind.mockResolvedValue({ repository });
  draftFind.mockResolvedValue({ repository });
  getService.mockResolvedValue({ getRepoForUser: verify });
  verify.mockResolvedValue({ id: 99, private: true });
});

describe('repository content authorization', () => {
  it.each(['repository', 'job', 'draft'] as const)('denies legacy %s content after GitHub revokes access', async resource => {
    verify.mockRejectedValueOnce(new RepositoryAccessError());
    const res = mockRes(), next = mockNext();
    await requireRepositoryAccess(resource, 'id')(mockReq({ params: { id: 'old' }, auth: { userId: 'signed-in', githubId: '7' } }), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    const query = [repositoryFind, jobFind, draftFind].find(fn => fn.mock.calls.length)!;
    expect(query.mock.calls[0][0].where).toEqual(resource === 'repository'
      ? { id: 'old', userId: 'signed-in' } : { id: 'old', repository: { userId: 'signed-in' } });
  });

  it.each(['repository', 'job', 'draft'] as const)('allows verified %s content using signed identity', async resource => {
    const res = mockRes(), next = mockNext();
    await requireRepositoryAccess(resource, 'id')(mockReq({ params: { id: 'owned' }, auth: { userId: 'owner', githubId: '7' }, body: { githubId: 'victim' } }), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledWith('company', 'private', '7', { expectedRepoId: '99', requireMembership: true });
  });

  it('uses body jobId for draft creation but never body user identity', async () => {
    const next = mockNext();
    await requireRepositoryAccess('job', 'jobId', true)(mockReq({ body: { jobId: 'job-1', githubId: 'victim' }, auth: { userId: 'owner', githubId: '7' } }), mockRes(), next);
    expect(jobFind.mock.calls[0][0].where.id).toBe('job-1');
    expect(verify.mock.calls[0][2]).toBe('7');
    expect(next).toHaveBeenCalledOnce();
  });

  it('returns 404 for a foreign resource without probing GitHub', async () => {
    jobFind.mockResolvedValueOnce(null);
    const res = mockRes(), next = mockNext();
    await requireRepositoryAccess('job', 'id')(mockReq({ params: { id: 'foreign' }, auth: { userId: 'stranger', githubId: '7' } }), res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(getService).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('never uses another tenant installation', async () => {
    repositoryFind.mockResolvedValueOnce({ ...repository, installation: { userId: 'victim', githubInstallationId: BigInt(44) } });
    const res = mockRes();
    await requireRepositoryAccess('repository', 'id')(mockReq({ params: { id: 'repo' }, auth: { userId: 'stranger', githubId: '7' } }), res, mockNext());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(getService).not.toHaveBeenCalled();
  });

  it('returns a sanitized unavailable response for missing credentials/storage failures', async () => {
    getService.mockRejectedValueOnce(new Error('token internal-secret database-host'));
    const res = mockRes(), next = mockNext();
    await requireRepositoryAccess('job', 'id')(mockReq({ params: { id: 'job' }, auth: { userId: 'owner', githubId: '7' } }), res, next);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(JSON.stringify(res.json.mock.calls)).not.toMatch(/token|internal-secret|database-host/);
    expect(next).not.toHaveBeenCalled();
  });
});
