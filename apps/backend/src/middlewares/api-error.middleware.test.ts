import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { inspect } from 'node:util';
import { apiErrorHandler } from './api-error.middleware';
afterEach(() => vi.restoreAllMocks());

describe('safe registration and async API failures', () => {
  it('returns fixed errors and safe diagnostics for rejected registration handlers', async () => {
    const app = express();
    const secret = 'private-database-password-and-github-token';
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    app.get('/signup', async () => { throw Object.assign(new Error(secret), {
      status: 500, config: { headers: { Authorization: secret } }, cause: new Error(secret),
    }); });
    app.use(apiErrorHandler);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => { server.once('listening', resolve); });
    try {
      const port = (server.address() as { port: number }).port;
      const response = await fetch(`http://127.0.0.1:${port}/signup`);
      const body = await response.json();
      expect(response.status).toBe(500);
      expect(body).toEqual({ error: 'Request could not be completed. Please retry.' });
      expect(inspect([body, log.mock.calls], { depth: null })).not.toContain(secret);
      expect(log).toHaveBeenCalledWith('API request failed', { status: 500 });
    } finally { await new Promise<void>(resolve => { server.close(() => resolve()); }); }
  });
});
