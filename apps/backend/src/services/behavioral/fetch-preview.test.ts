import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ dns: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: m.dns }));
vi.mock('node:https', () => ({ request: m.request }));
import { fetchPreview } from './destination-policy';
beforeEach(() => { vi.resetAllMocks(); m.dns.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]); });
function reply(headers: Record<string, string> = {}, body = 'hello') {
  m.request.mockImplementation((_url, _options, callback) => {
    const req = new EventEmitter() as any;
    req.destroy = (error: Error) => { req.emit('error', error); req.emit('close'); };
    req.end = () => { const response = Object.assign(new EventEmitter(), { statusCode: 200, headers }); callback(response); response.emit('data', Buffer.from(body)); response.emit('end'); req.emit('close'); };
    return req;
  });
}
describe('public preview transport', () => {
  it('pins the checked DNS address, disables connection reuse and strips credentials/cookies', async () => {
    reply({ 'content-type': 'text/html', 'set-cookie': 'private=secret', authorization: 'Bearer secret' });
    const result = await fetchPreview('https://preview.example.com', 'preview.example.com', { requests: 0, bytes: 0 });
    const options = m.request.mock.calls[0][1]; const callback = vi.fn(); options.lookup('preview.example.com', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    expect(options.agent).toBe(false); expect(options.autoSelectFamily).toBe(false);
    expect(JSON.stringify(options.headers)).not.toMatch(/Cookie|Authorization/i);
    expect(JSON.stringify(result.headers)).not.toContain('secret');
  });
  it.each(['http://preview.example.com', 'https://127.0.0.1', 'https://evil.com', 'https://user:pass@preview.example.com'])('blocks unsafe redirects to %s', async location => {
    reply({ location });
    await expect(fetchPreview('https://preview.example.com', 'preview.example.com', { requests: 0, bytes: 0 })).rejects.toThrow();
  });
  it('rejects rebinding/mixed DNS before opening a socket', async () => {
    m.dns.mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 }]);
    await expect(fetchPreview('https://preview.example.com', 'preview.example.com', { requests: 0, bytes: 0 })).rejects.toThrow();
    expect(m.request).not.toHaveBeenCalled();
  });
  it('enforces a hard request budget without network access', async () => {
    await expect(fetchPreview('https://preview.example.com', 'preview.example.com', { requests: 100, bytes: 0 })).rejects.toThrow(/budget/);
    expect(m.dns).not.toHaveBeenCalled(); expect(m.request).not.toHaveBeenCalled();
  });
});
