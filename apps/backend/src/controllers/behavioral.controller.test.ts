import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockReq, mockRes } from '../test-utils/express-mocks';
const mocks = vi.hoisted(() => ({ find: vi.fn(), runs: vi.fn(), update: vi.fn(), run: vi.fn(), claim: vi.fn(), identity: vi.fn(), gh: vi.fn(), preview: vi.fn() }));
vi.mock('../config/prisma', () => ({ default: { analysisJob: { findFirst: mocks.find }, behavioralRun: { findMany: mocks.runs, findUnique: mocks.run, updateMany: mocks.claim }, repository: { update: mocks.update } } }));
vi.mock('../services/github-app.service', () => ({ GitHubAppService: { getInstallationService: mocks.gh } }));
vi.mock('../services/behavioral/oidc', () => ({ verifyCiToken: mocks.identity }));
import { BehavioralController } from './behavioral.controller';
const req = (body = {}) => Object.assign(mockReq({ params: { jobId: 'job', runId: 'run' }, body }), { auth: { userId: 'owner' } });
beforeEach(() => vi.resetAllMocks());
describe('behavioral tenant boundary', () => {
  it.each(['get', 'configure', 'start'] as const)('rejects another tenant at %s', async method => {
    mocks.find.mockResolvedValue(null);
    const response = mockRes();
    await BehavioralController[method](req(), response);
    expect(response.status).toHaveBeenCalledWith(404);
    expect(mocks.find).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'job', repository: { userId: 'owner', isActive: true } } }));
    expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.gh).not.toHaveBeenCalled();
  });
  it('requires explicit owner confirmation to enable execution', async () => {
    mocks.find.mockResolvedValue({ repository: {} });
    const response = mockRes();
    await BehavioralController.configure(req({ config: {} }), response);
    expect(response.status).toHaveBeenCalledWith(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('does not expose legacy runs or invent Phase 5 scenarios', async () => {
    mocks.find.mockResolvedValue({ id: 'job', results: [{ issue: 'old' }], repository: { behavioralConfig: null } });
    mocks.runs.mockResolvedValue([]);
    const response = mockRes();
    await BehavioralController.get(req(), response);
    expect(response.json).toHaveBeenCalledWith({ config: null, report: undefined, runs: [] });
  });
  it('rejects CI callbacks without a dispatch proof before accepting OIDC', async () => {
    mocks.run.mockResolvedValue({ dispatchHash: 'secret' });
    const response = mockRes();
    await BehavioralController.claim(req({ dispatchToken: 'no' }), response);
    expect(response.status).toHaveBeenCalledWith(401);
    expect(mocks.identity).not.toHaveBeenCalled(); expect(mocks.claim).not.toHaveBeenCalled();
  });
});
