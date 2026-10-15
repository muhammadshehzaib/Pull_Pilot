import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCipheriv, scryptSync } from 'node:crypto';
import { EncryptionService } from './encryption.service';

const originalKey = process.env.ENCRYPTION_KEY;
beforeEach(() => { process.env.ENCRYPTION_KEY = 'test-secret-key-used-only-for-vitest!!!'; vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { process.env.ENCRYPTION_KEY = originalKey; vi.restoreAllMocks(); });

describe('asynchronous encryption', () => {
  it.each(['', 'my-api-key', 'مرحبا 🌍 héllo', JSON.stringify({ token: 'private' }), 'A'.repeat(1024 * 1024)])('round-trips payload %#', async text => {
    const value = await EncryptionService.encrypt(text);
    expect(value.iv).toMatch(/^[0-9a-f]{32}$/);
    expect(value.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(value.authTag).toMatch(/^[0-9a-f]{32}$/);
    expect(await EncryptionService.decrypt(value.encryptedData, value.iv, value.authTag, value.salt)).toBe(text);
  });
  it('keeps independent random IVs/salts and hides plaintext', async () => {
    const [a, b] = await Promise.all([EncryptionService.encrypt('private-key'), EncryptionService.encrypt('private-key')]);
    expect(a.iv).not.toBe(b.iv); expect(a.salt).not.toBe(b.salt); expect(a.encryptedData).not.toBe(b.encryptedData);
    expect(JSON.stringify(a)).not.toContain('private-key');
  });
  it.each(['encryptedData', 'iv', 'authTag', 'salt'] as const)('rejects tampered %s', async field => {
    const value = await EncryptionService.encrypt('private-key');
    value[field] = (value[field][0] === '0' ? '1' : '0') + value[field].slice(1);
    await expect(EncryptionService.decrypt(value.encryptedData, value.iv, value.authTag, value.salt)).rejects.toThrow('Decryption failure');
  });
  it('reads records produced by the old synchronous implementation', async () => {
    const salt = Buffer.alloc(16, 3), iv = Buffer.alloc(16, 7);
    const key = scryptSync(process.env.ENCRYPTION_KEY!, salt, 32);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update('legacy-saved-key', 'utf8'), cipher.final()]).toString('hex');
    expect(await EncryptionService.decrypt(ciphertext, iv.toString('hex'), cipher.getAuthTag().toString('hex'), salt.toString('hex'))).toBe('legacy-saved-key');
  });
  it('rejects missing configuration and malformed ciphertext without raw crypto details', async () => {
    delete process.env.ENCRYPTION_KEY;
    await expect(EncryptionService.encrypt('private')).rejects.toThrow('ENCRYPTION_KEY');
    process.env.ENCRYPTION_KEY = 'test-secret-key-used-only-for-vitest!!!';
    await expect(EncryptionService.decrypt('zzzz', 'zzzz', 'zzzz', 'zzzz')).rejects.toThrow('Decryption failure - key may be compromised or invalid.');
  });
  it('allows event-loop work while a batch of derivations is pending', async () => {
    let settled = false;
    const pending = Promise.all(Array.from({ length: 16 }, () => EncryptionService.encrypt('key'))).then(() => { settled = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    await pending;
  });
  it('bounds the derivation backlog instead of admitting unbounded expensive work', async () => {
    const results = await Promise.allSettled(Array.from({ length: 80 }, () => EncryptionService.encrypt('key')));
    expect(results.some(result => result.status === 'rejected')).toBe(true);
    expect(results.some(result => result.status === 'fulfilled')).toBe(true);
    // Capacity is released even after rejection.
    await expect(EncryptionService.encrypt('next')).resolves.toHaveProperty('encryptedData');
  }, 15000);
});
