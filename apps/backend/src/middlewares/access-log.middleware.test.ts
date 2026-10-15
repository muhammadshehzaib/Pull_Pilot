import { describe, it, expect } from 'vitest';
import express from 'express';
import { createServer, get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAccessLogger } from './access-log.middleware';

describe('access logging', () => {
  it.each(['/api/auth/github/callback', '/api/auth/github-app/callback', '/api/repositories'])(
    'logs path/status/timing without credentials or query strings for %s', async path => {
      const lines: string[] = [];
      const app = express();
      app.use(createAccessLogger({ write: line => { lines.push(line); } }));
      app.use((_req, res) => { res.status(500).json({ error: 'OAuth exchange failed' }); });
      const server = createServer(app);
      await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
      try {
        const { port } = server.address() as AddressInfo;
        await new Promise<void>((resolve, reject) => {
          get({ hostname: '127.0.0.1', port,
            path: `${path}?code=private-oauth-code&state=private-oauth-state&access_token=private-token&client_secret=private-secret`,
            headers: { Authorization: 'Bearer private-token', Cookie: 'session=private-cookie', 'User-Agent': 'private-user-agent' },
          }, res => { res.resume(); res.on('end', resolve); }).on('error', reject);
        });
        const output = lines.join('');
        expect(output).toContain(`GET ${path} 500 `);
        expect(output).toMatch(/500 \d+(?:\.\d+)? ms - \d+/);
        expect(output).not.toContain('?');
        for (const secret of ['private-oauth-code', 'private-oauth-state', 'private-token', 'private-secret', 'private-cookie', 'private-user-agent']) {
          expect(output).not.toContain(secret);
        }
      } finally {
        await new Promise<void>((resolve, reject) => { server.close(err => err ? reject(err) : resolve()); });
      }
    },
  );
});
