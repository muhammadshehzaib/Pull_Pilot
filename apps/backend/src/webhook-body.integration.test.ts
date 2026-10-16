import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import type { Request, Response } from 'express';

const { findRepos, createJob, queueAdd, accessLines } = vi.hoisted(() => ({
  findRepos: vi.fn(), createJob: vi.fn(), queueAdd: vi.fn(), accessLines: [] as string[],
}));

vi.mock('./config/prisma', () => ({ default: {
  repository: { findMany: findRepos }, analysisJob: { create: createJob },
} }));
vi.mock('./config/queue', () => ({ analysisQueue: { add: queueAdd } }));
vi.mock('./services/quota.service', () => ({ QuotaService: {
  checkQuota: vi.fn(async () => ({ allowed: true })),
  reserveReview: vi.fn(async () => ({ allowed: true })),
} }));
vi.mock('./services/github-app.service', () => ({ GitHubAppService: {} }));
vi.mock('./services/repository-context-cache.service', () => ({ RepositoryContextCache: class {} }));
// Use the actual production app and webhook route/controller. Other routes do
// not participate in these tests and must not open Redis/database connections.
vi.mock('./routes/auth.routes', () => ({ default: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock('./routes/vault.routes', () => ({ default: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock('./routes/repository.routes', () => ({ default: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock('./routes/rules.routes', () => ({ default: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock('./routes/job.routes', () => ({ default: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock('./routes/test-draft.routes', () => ({ default: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock('./routes/billing.routes', () => ({ default: (req: Request, res: Response) => {
  res.json({ raw: req.rawBody?.toString('utf8') });
} }));
vi.mock('./routes/behavioral.routes', () => ({ default: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock('./routes/dashboard.routes', () => ({ default: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock('./middlewares/access-log.middleware', async importOriginal => {
  const actual = await importOriginal<typeof import('./middlewares/access-log.middleware')>();
  return { createAccessLogger: () => actual.createAccessLogger({ write: line => { accessLines.push(line); } }) };
});

import app from './app';
import { API_BODY_LIMIT, GITHUB_WEBHOOK_BODY_LIMIT } from './middlewares/request-body.middleware';

const secret = 'test-only-webhook-signing-key';
let server: Server;
let origin: string;

beforeAll(async () => {
  vi.stubEnv('GITHUB_WEBHOOK_SECRET', secret);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => { server.once('listening', resolve); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); });
  vi.unstubAllEnvs();
});
beforeEach(() => {
  vi.clearAllMocks();
  accessLines.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  findRepos.mockResolvedValue([{ id: 'repo-1', userId: 'customer-1', installationId: null, isPrivate: true }]);
  createJob.mockResolvedValue({ id: 'job-1' });
  queueAdd.mockResolvedValue({});
});
afterEach(() => vi.restoreAllMocks());

function headers(raw: string, event = 'ping') {
  return {
    'Content-Type': 'application/json',
    'X-GitHub-Event': event,
    'X-Hub-Signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
  };
}

function sizedJson(size: number) {
  const empty = '{"description":""}';
  return `{"description":"${'x'.repeat(size - Buffer.byteLength(empty))}"}`;
}

describe('production GitHub webhook request parsing', () => {
  it.each(['push', 'pull_request'])('queues a signed %s payload larger than 100 KiB', async event => {
    const raw = JSON.stringify({
      action: 'opened',
      repository: { id: 123, full_name: 'customer/private-repo', private: true },
      before: 'base-sha', after: 'head-sha',
      pull_request: { number: 7, head: { sha: 'head-sha' }, base: { sha: 'base-sha' } },
      description: 'x'.repeat(250 * 1024),
      unicode: 'é',
    }).replace('é', '\\u00e9');
    const response = await fetch(`${origin}/api/webhooks/github`, { method: 'POST', headers: headers(raw, event), body: raw });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: 'QUEUED', jobId: 'job-1' });
    expect(queueAdd).toHaveBeenCalledExactlyOnceWith(expect.any(String), expect.objectContaining({
      userId: 'customer-1', eventType: event === 'push' ? 'PUSH' : 'PULL_REQUEST',
      payloadSnapshot: { headSha: 'head-sha', baseSha: 'base-sha' },
    }), { jobId: 'job-1' });
  });

  it('accepts a correctly signed payload at the exact 25 MiB limit', async () => {
    const raw = sizedJson(GITHUB_WEBHOOK_BODY_LIMIT);
    const response = await fetch(`${origin}/api/webhooks/github`, { method: 'POST', headers: headers(raw), body: raw });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: 'pong' });
  });

  it('rejects a payload one byte over the limit with safe diagnostics and an access log', async () => {
    const raw = sizedJson(GITHUB_WEBHOOK_BODY_LIMIT + 1).replace('xxx', 'key');
    const response = await fetch(`${origin}/api/webhooks/github?token=private-query`, {
      method: 'POST', headers: headers(raw), body: raw,
    });
    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body).toEqual({ error: 'Request body exceeds the allowed size limit.', code: 'PAYLOAD_TOO_LARGE', limitBytes: GITHUB_WEBHOOK_BODY_LIMIT });
    expect(console.warn).toHaveBeenCalledWith('Request body rejected: size limit exceeded', {
      status: 413, limitBytes: GITHUB_WEBHOOK_BODY_LIMIT, receivedBytes: GITHUB_WEBHOOK_BODY_LIMIT + 1,
    });
    expect(accessLines.join('')).toContain('POST /api/webhooks/github 413 ');
    expect(JSON.stringify([body, vi.mocked(console.warn).mock.calls, accessLines])).not.toContain('private-query');
    expect(findRepos).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('enforces the limit for chunked requests with no Content-Length', async () => {
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(`${origin}/api/webhooks/github`, { method: 'POST', headers: headers('{}') }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      });
      req.on('error', reject);
      req.write('{"description":"');
      const chunk = 'x'.repeat(1024 * 1024);
      for (let index = 0; index < 25; index++) req.write(chunk);
      req.end('"}');
    });
    expect(result.status).toBe(413);
    expect(JSON.parse(result.body)).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', limitBytes: GITHUB_WEBHOOK_BODY_LIMIT });
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('rejects large payloads with invalid signatures before touching the database', async () => {
    const raw = sizedJson(200 * 1024);
    const response = await fetch(`${origin}/api/webhooks/github`, {
      method: 'POST', headers: headers(raw.replace('xxx', 'bad')), body: raw,
    });
    expect(response.status).toBe(401);
    expect(findRepos).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('rejects missing signatures on large payloads', async () => {
    const raw = sizedJson(200 * 1024);
    const response = await fetch(`${origin}/api/webhooks/github`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'ping' }, body: raw,
    });
    expect(response.status).toBe(401);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('retains the 100 KiB limit on ordinary API routes', async () => {
    const response = await fetch(`${origin}/api/auth/anything`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: sizedJson(API_BODY_LIMIT + 1),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', limitBytes: API_BODY_LIMIT });
  });

  it('accepts ordinary API JSON at its exact limit', async () => {
    const raw = sizedJson(API_BODY_LIMIT);
    const response = await fetch(`${origin}/api/billing/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ raw });
  });

  it('preserves exact raw bytes on the billing path for its existing signature verifier', async () => {
    const raw = '{ "description": "\\u00e9", "count": 1 }';
    const response = await fetch(`${origin}/api/billing/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ raw });
  });

  it('does not extend the allowance to other webhook paths', async () => {
    const response = await fetch(`${origin}/api/webhooks/github/anything`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: sizedJson(API_BODY_LIMIT + 1),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ limitBytes: API_BODY_LIMIT });
  });

  it('returns a safe 400 for malformed JSON and logs the rejection', async () => {
    const raw = '{"password":"private-payload-secret", invalid';
    const response = await fetch(`${origin}/api/webhooks/github`, { method: 'POST', headers: headers(raw), body: raw });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({ error: 'Request could not be completed. Please retry.' });
    expect(accessLines.join('')).toContain('POST /api/webhooks/github 400 ');
    expect(JSON.stringify([body, vi.mocked(console.error).mock.calls, accessLines])).not.toContain('private-payload-secret');
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('bounds decompressed JSON size too', async () => {
    const raw = sizedJson(GITHUB_WEBHOOK_BODY_LIMIT + 1);
    const compressed = gzipSync(raw);
    const response = await fetch(`${origin}/api/webhooks/github`, {
      method: 'POST', headers: { ...headers(raw), 'Content-Encoding': 'gzip' }, body: compressed,
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(queueAdd).not.toHaveBeenCalled();
  });
});
