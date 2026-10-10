import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../services/analytics/dashboard.service', () => ({ engineeringHealth: read }));
vi.mock('../services/auth.service', () => ({ AuthService: { verifyToken: (token: string) => {
  if (token !== 'owner-token') throw new Error('invalid'); return { userId: 'owner' };
} } }));
import dashboardRoutes from './dashboard.routes';
import { DashboardError } from '../services/analytics/model';

let server: Server, origin: string;
beforeAll(async () => {
  const app = express(); app.use('/api/dashboard', dashboardRoutes);
  server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/dashboard`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
beforeEach(() => {
  vi.clearAllMocks(); read.mockResolvedValue({ version: 1, scope: { end: 'snapshot' }, coverage: { partial: true },
    trend: [], repositories: { items: [] }, reviews: { items: [] } });
});
const request = (path = '/engineering-health', authenticated = true) => fetch(`${origin}${path}`, {
  headers: authenticated ? { Authorization: 'Bearer owner-token' } : {},
});
describe('authenticated dashboard HTTP contract', () => {
  it('rejects anonymous requests before any analytics read', async () => {
    expect((await request('/engineering-health', false)).status).toBe(401); expect(read).not.toHaveBeenCalled();
  });
  it('does not accept actor IDs from query parameters and disables shared caching', async () => {
    const response = await request('/engineering-health?userId=other');
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(read).toHaveBeenCalledWith('owner', expect.objectContaining({ range: '30d' }));
  });
  it.each(['/engineering-health?range=365d', '/reviews?limit=100', '/risk-trend?bucket=month', '/reviews?asOf=bad'])('rejects unsafe filters %s', async path => {
    expect((await request(path)).status).toBe(400); expect(read).not.toHaveBeenCalled();
  });
  it('reports foreign repository as unavailable without details', async () => {
    read.mockRejectedValue(new DashboardError(404, 'Repository unavailable'));
    expect((await request('/reviews?repositoryId=foreign')).status).toBe(404);
  });
  it('sanitizes storage failures and never reports failed queries as zero', async () => {
    read.mockRejectedValue(new Error('postgres://secret internal SQL source'));
    const response = await request(); expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/postgres|secret|SQL/);
  });
  it.each(['risk-trend', 'reviews', 'repositories'])('returns consistent scope and coverage for %s drilldown', async path => {
    const response = await request(`/${path}`); const body = await response.json();
    expect(response.status).toBe(200); expect(body.scope).toEqual({ end: 'snapshot' }); expect(body.coverage.partial).toBe(true);
    expect(body).not.toHaveProperty('version');
  });
});
