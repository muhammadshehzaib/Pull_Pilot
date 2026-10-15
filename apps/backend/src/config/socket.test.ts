import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import { SocketService } from './socket';
import { AuthService } from '../services/auth.service';

const server = createServer();
let origin: string;
let socketServer: ReturnType<typeof SocketService.init>;
const clients: Socket[] = [];

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  socketServer = SocketService.init(server);
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => { for (const client of clients.splice(0)) client.disconnect(); });
afterAll(async () => {
  await new Promise<void>(resolve => { socketServer.close(() => resolve()); });
  vi.restoreAllMocks();
});

function connect(token?: string): Promise<Socket> {
  const client = io(origin, { auth: token ? { token } : {}, transports: ['websocket'],
    reconnection: false, forceNew: true, timeout: 1000 });
  clients.push(client);
  return new Promise((resolve, reject) => {
    client.once('connect', () => resolve(client));
    client.once('connect_error', reject);
  });
}

describe('live socket customer isolation', () => {
  it.each([undefined, 'forged-token'])('rejects missing or forged credentials: %#', async token => {
    await expect(connect(token)).rejects.toThrow('Unauthorized');
  });

  it('keeps private updates in signed owner rooms despite a client-requested foreign join', async () => {
    const alice = await connect(AuthService.issueToken({ userId: 'alice', githubId: '7' }));
    const bob = await connect(AuthService.issueToken({ userId: 'bob', githubId: '8' }));
    const bobPrivate = vi.fn();
    bob.on('job-update:job-a', bobPrivate);
    const bobActivities: { jobId: string }[] = [];
    bob.on('dashboard:activity', data => bobActivities.push(data));
    const aliceUpdate = new Promise<any>(resolve => { alice.once('job-update:job-a', resolve); });
    const bobSentinel = new Promise<void>(resolve => {
      bob.on('dashboard:activity', data => { if (data.jobId === 'job-b') resolve(); });
    });
    bob.emit('join', 'user:alice');
    SocketService.emitStatus('alice', 'job-a', 'private-alice-message', 'ANALYZING', { marker: 'private-alice-data' });
    SocketService.emitStatus('bob', 'job-b', 'bob-message', 'ANALYZING');
    expect(await aliceUpdate).toMatchObject({ marker: 'private-alice-data' });
    await bobSentinel;
    expect(bobPrivate).not.toHaveBeenCalled();
    expect(bobActivities.map(data => data.jobId)).toEqual(['job-b']);
    expect(JSON.stringify(bobActivities)).not.toContain('private-alice');
  });
});
