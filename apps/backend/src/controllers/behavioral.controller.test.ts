import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockReq, mockRes } from '../test-utils/express-mocks';
import { createHash } from 'node:crypto';
const mocks = vi.hoisted(() => ({ find: vi.fn(), runs: vi.fn(), update: vi.fn(), run: vi.fn(), claim: vi.fn(), identity: vi.fn(), gh: vi.fn(), preview: vi.fn() }));
vi.mock('../config/prisma', () => ({ default: { analysisJob: { findFirst: mocks.find }, behavioralRun: { findMany: mocks.runs, findUnique: mocks.run, updateMany: mocks.claim }, repository: { update: mocks.update } } }));
vi.mock('../services/github-app.service', () => ({ GitHubAppService: { getInstallationService: mocks.gh } }));
vi.mock('../services/behavioral/oidc', () => ({ verifyCiToken: mocks.identity }));
import { BehavioralController } from './behavioral.controller';
const req = (body = {}) => Object.assign(mockReq({ params: { jobId: 'job', runId: 'run' }, body }), { auth: { userId: 'owner' } });
beforeEach(() => vi.resetAllMocks());
describe('behavioral tenant boundary', () => {
  const sandbox = { dockerfile: 'Dockerfile', port: 3000, readyPath: '/', sessionPath: '/__aipr/session', mutations: [{ method: 'POST', path: '/orders' }], assertions: ['/__aipr/state'] };
  const execution = { mode: 'OWNER_SANDBOX', sandbox };
  function ciRun() {
    return { id: 'run', plan: { version: 2, scenarios: [{ id: 'a'.repeat(24), steps: [{ action: 'navigate', path: '/' }, { action: 'assertJson', path: '/__aipr/state', pointer: '/orderCount', equals: 1 }] }], execution }, headSha: 'a'.repeat(40), workflowSha: 'b'.repeat(40), workflowRef: 'o/r/.github/workflows/aipr-behavioral.yml@refs/heads/main', previewUrl: 'https://sandbox.aipr.invalid', dispatchHash: createHash('sha256').update('d'.repeat(64)).digest('hex'), expiresAt: new Date(Date.now() + 100000), deadlineAt: new Date(Date.now() + 100000), repository: { fullName: 'o/r', isActive: true, githubRepoId: 42n, userId: 'owner', installation: { userId: 'owner', githubInstallationId: 1n }, behavioralConfig: { enabled: true, workflowSha: 'b'.repeat(40), execution } } };
  }
  it('claims a frozen sandbox without requiring a public deployment', async () => {
    mocks.run.mockResolvedValue(ciRun()); mocks.identity.mockResolvedValue({ runId: '123' }); mocks.claim.mockResolvedValue({ count: 1 });
    const response = mockRes();
    await BehavioralController.claim(req({ dispatchToken: 'd'.repeat(64) }), response);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ execution, headSha: 'a'.repeat(40), repository: 'o/r', previewUrl: 'https://sandbox.aipr.invalid', plan: expect.any(Array) }));
    expect(mocks.gh).not.toHaveBeenCalled();
  });
  it.each(['port', 'mode', 'disabled'] as const)('revokes a sandbox claim when %s changes', change => {
    const run = ciRun();
    if (change === 'port') run.repository.behavioralConfig.execution = { ...execution, sandbox: { ...sandbox, port: 4000 } };
    if (change === 'mode') (run.repository.behavioralConfig as any) = { enabled: true, workflowSha: run.workflowSha, previewHost: 'preview.example.com', environment: 'preview', publishers: ['deploy[bot]'] };
    if (change === 'disabled') run.repository.behavioralConfig.enabled = false;
    mocks.run.mockResolvedValue(run);
    return (async () => {
      const response = mockRes(); await BehavioralController.claim(req({ dispatchToken: 'd'.repeat(64) }), response);
      expect(response.status).toHaveBeenCalledWith(403); expect(mocks.claim).not.toHaveBeenCalled();
    })();
  });
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
