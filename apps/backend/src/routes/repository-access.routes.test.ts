import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

const { findRepo, findJob, findDraft, verify, reached, controllers } = vi.hoisted(() => {
  const reached = vi.fn((_req: unknown, res: any) => res.json({ reached: true }));
  return { findRepo: vi.fn(), findJob: vi.fn(), findDraft: vi.fn(), verify: vi.fn(), reached,
    controllers: new Proxy({}, { get: () => reached }) };
});
vi.mock('../config/prisma', () => ({ default: {
  repository: { findFirst: findRepo }, analysisJob: { findFirst: findJob }, testDraft: { findFirst: findDraft },
} }));
vi.mock('../services/github-app.service', () => ({ GitHubAppService: { getInstallationService: async () => ({ getRepoForUser: verify }) } }));
vi.mock('../services/auth.service', () => ({ AuthService: { verifyToken: (token: string) => {
  if (token === 'other-signed-in') return { userId: 'other-owner', githubId: '8' };
  if (token !== 'signed-in') throw new Error('invalid');
  return { userId: 'owner', githubId: '7' };
} } }));
vi.mock('../controllers/repository.controller', () => ({ RepositoryController: controllers }));
vi.mock('../controllers/job.controller', () => ({ JobController: controllers }));
vi.mock('../controllers/rules.controller', () => ({ RulesController: controllers }));
vi.mock('../controllers/test-draft.controller', () => ({ TestDraftController: controllers }));
vi.mock('../controllers/behavioral.controller', () => ({ BehavioralController: controllers }));
vi.mock('../controllers/finding.controller', () => ({ FindingController: controllers }));
vi.mock('../controllers/feedback-loop.controller', () => ({ FeedbackLoopController: controllers }));
vi.mock('../middlewares/feedback-rate-limit', () => ({ feedbackRateLimit: (_req: unknown, _res: unknown, next: () => void) => next() }));

import repositoryRoutes from './repository.routes';
import jobRoutes from './job.routes';
import rulesRoutes from './rules.routes';
import draftRoutes from './test-draft.routes';
import behavioralRoutes from './behavioral.routes';
import { RepositoryAccessError } from '../errors/repository-access.error';

let server: Server, origin: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/repositories', repositoryRoutes);
  app.use('/api/repositories', rulesRoutes);
  app.use('/api/jobs', jobRoutes);
  app.use('/api/test-drafts', draftRoutes);
  app.use('/api/behavioral', behavioralRoutes);
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
beforeEach(() => {
  vi.clearAllMocks();
  reached.mockImplementation((_req: unknown, res: any) => res.json({ reached: true }));
  const repository = { fullName: 'company/private', githubRepoId: BigInt(99), isPrivate: true, installation: null };
  findRepo.mockResolvedValue(repository);
  findJob.mockResolvedValue({ repository });
  findDraft.mockResolvedValue({ repository });
  verify.mockResolvedValue({ id: 99, private: true });
});
const request = (method: string, path: string, authenticated = true, token = 'signed-in') => fetch(`${origin}/api${path}`, {
  method, headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) },
  ...(['POST', 'PUT', 'PATCH'].includes(method) ? { body: JSON.stringify({ jobId: 'job-1' }) } : {}),
});

const contentRoutes = [
  ['POST', '/repositories/repo-1/analyze'],
  ['GET', '/repositories/repo-1/historical-insights'],
  ['GET', '/repositories/repo-1/historical-intelligence/settings'],
  ['GET', '/repositories/repo-1/feedback-insights'],
  ['PUT', '/repositories/repo-1/feedback-adaptation'],
  ['GET', '/repositories/repo-1/rules'],
  ['POST', '/repositories/repo-1/rules'],
  ['GET', '/jobs/job-1'],
  ['GET', '/jobs/job-1/findings'],
  ['GET', '/jobs/job-1/findings/finding-1/feedback/events'],
  ['PUT', '/jobs/job-1/findings/finding-1/feedback'],
  ['PUT', '/jobs/job-1/findings/finding-1/workflow'],
  ['POST', '/jobs/job-1/findings/finding-1/rule-draft'],
  ['POST', '/jobs/job-1/comments/reconcile'],
  ['GET', '/jobs/job-1/test-drafts'],
  ['POST', '/test-drafts'],
  ['GET', '/test-drafts/draft-1'],
  ['PUT', '/test-drafts/draft-1'],
  ['POST', '/test-drafts/draft-1/create-pr'],
  ['GET', '/behavioral/jobs/job-1'],
  ['PUT', '/behavioral/jobs/job-1/config'],
  ['POST', '/behavioral/jobs/job-1/runs'],
];

describe('private repository HTTP authorization', () => {
  it.each(contentRoutes)('denies another signed-in customer before GitHub calls: %s %s', async (method, path) => {
    const repository = { fullName: 'company/private', userId: 'owner', githubRepoId: 99n, isPrivate: true, installation: null };
    findRepo.mockImplementation(async ({ where }) => where.userId === 'owner' ? repository : null);
    findJob.mockImplementation(async ({ where }) => where.repository.userId === 'owner' ? { repository } : null);
    findDraft.mockImplementation(async ({ where }) => where.repository.userId === 'owner' ? { repository } : null);
    const response = await request(method, path, true, 'other-signed-in');
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('private');
    expect(verify).not.toHaveBeenCalled();
    expect(reached).not.toHaveBeenCalled();
  });

  it('keeps two customers isolated across 1000 interleaved HTTP requests with 50 in flight', async () => {
    const repositories = {
      'owner': { fullName: 'owner/private', githubRepoId: 99n, isPrivate: true, installation: null },
      'other-owner': { fullName: 'other/private', githubRepoId: 100n, isPrivate: true, installation: null },
    };
    findJob.mockImplementation(async ({ where }) => {
      const expectedOwner = where.id === 'job-a' ? 'owner' : 'other-owner';
      return where.repository.userId === expectedOwner ? { repository: repositories[expectedOwner] } : null;
    });
    reached.mockImplementation((req: any, res: any) => res.json({ tenant: req.auth.userId, job: req.params.id }));
    const started = performance.now();
    let allowed = 0, denied = 0;
    const latencies: number[] = [];
    for (let offset = 0; offset < 1000; offset += 50) {
      await Promise.all(Array.from({ length: 50 }, async (_, index) => {
        const n = offset + index;
        const tenant = n % 2 === 0 ? 'owner' : 'other-owner';
        const token = tenant === 'owner' ? 'signed-in' : 'other-signed-in';
        const own = n % 4 < 2;
        const job = (tenant === 'owner') === own ? 'job-a' : 'job-b';
        const start = performance.now();
        const response = await request('GET', `/jobs/${job}`, true, token);
        const body = await response.json();
        latencies.push(performance.now() - start);
        expect(response.status).toBe(own ? 200 : 404);
        if (own) {
          allowed++;
          expect(body).toEqual({ tenant, job });
        } else {
          denied++;
          expect(body).toEqual({ error: 'Resource not found' });
        }
      }));
    }
    latencies.sort((a, b) => a - b);
    expect([allowed, denied]).toEqual([500, 500]);
    expect(verify).toHaveBeenCalledTimes(500);
    console.log(JSON.stringify({ verification: 'synthetic-authorization-http', requests: 1000,
      maxInFlight: 50, allowed, denied, elapsedMs: Math.round(performance.now() - started),
      p95Ms: Math.round(latencies[Math.ceil(latencies.length * 0.95) - 1]),
      limitation: 'Mocked persistence/GitHub/controllers; not production capacity or 1000 simultaneous customers.' }));
  }, 15000);

  it.each(contentRoutes)('blocks a legacy unauthorized connection: %s %s', async (method, path) => {
    verify.mockRejectedValue(new RepositoryAccessError());
    const response = await request(method, path);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('reached');
    expect(reached).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledOnce();
  });

  it.each(contentRoutes)('allows verified collaborator access: %s %s', async (method, path) => {
    const response = await request(method, path);
    expect(response.status).toBe(200);
    expect(verify).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledWith('company', 'private', '7', { expectedRepoId: '99', requireMembership: true });
    expect(reached).toHaveBeenCalledOnce();
  });

  it('rejects anonymous requests before ownership or permission lookups', async () => {
    expect((await request('GET', '/jobs/job-1', false)).status).toBe(401);
    expect(findJob).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(reached).not.toHaveBeenCalled();
  });

  it('allows disconnecting after GitHub access is lost', async () => {
    verify.mockRejectedValue(new RepositoryAccessError());
    expect((await request('DELETE', '/repositories/repo-1')).status).toBe(200);
    expect(verify).not.toHaveBeenCalled();
    expect(reached).toHaveBeenCalledOnce();
  });

  it('reports upstream verification failures without returning content', async () => {
    verify.mockRejectedValue(new RepositoryAccessError(503));
    expect((await request('GET', '/jobs/job-1')).status).toBe(503);
    expect(reached).not.toHaveBeenCalled();
  });
});
