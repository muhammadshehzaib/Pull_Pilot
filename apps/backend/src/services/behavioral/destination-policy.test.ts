import { describe, expect, it, vi } from 'vitest';
import { isPublicAddress, previewHost, resolvePublic, validateDestination } from './destination-policy';
describe('preview SSRF policy', () => {
  it.each(['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '64:ff9b::a00:1', '2002:7f00:1::1', '192.0.2.1'])('rejects non-public address %s', address => expect(isPublicAddress(address)).toBe(false));
  it('accepts public unicast IPs only', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });
  it.each(['http://preview.example.com', 'https://user:pass@preview.example.com', 'https://preview.example.com:444', 'https://127.1', 'https://preview.example.com.evil.com', 'file:///etc/passwd', 'https://evil.com/#https://preview.example.com'])('blocks malicious destination %s', url => expect(() => validateDestination(url, 'preview.example.com')).toThrow());
  it.each(['*.example.com', 'localhost', 'foo.internal', 'foo.local', '127.0.0.1', 'EXAMPLE.com'])('rejects unsafe host configuration %s', host => expect(() => previewHost(host)).toThrow());
  it('rejects a mixed DNS answer and rechecks DNS for every connection', async () => {
    const resolver = vi.fn().mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    expect(await resolvePublic('preview.example.com', resolver as any)).toEqual({ address: '8.8.8.8', family: 4 });
    await expect(resolvePublic('preview.example.com', resolver as any)).rejects.toThrow();
    await expect(resolvePublic('preview.example.com', vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]) as any)).rejects.toThrow();
  });
});
