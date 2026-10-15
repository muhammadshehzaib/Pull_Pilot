import { beforeEach, describe, expect, it, vi } from 'vitest';
const store = vi.hoisted(() => ({ rows: new Map<string, unknown>(), unavailable: false }));
vi.mock('../config/prisma', () => ({ default: { revokedSession: {
  findUnique: vi.fn(async ({ where }) => { if (store.unavailable) throw new Error('internal database secret'); return store.rows.get(where.tokenHash) ?? null; }),
  upsert: vi.fn(async ({ create }) => { if (store.unavailable) throw new Error('internal database secret'); store.rows.set(create.tokenHash, create); return create; }),
  deleteMany: vi.fn(async () => ({})),
} } }));
import { AuthService, sessionHash, SessionUnavailableError } from './auth.service';
beforeEach(() => { store.rows.clear(); store.unavailable = false; });

describe('persistent logout revocation', () => {
  it('rejects replay of a copied token while preserving a separate login', async () => {
    const first = AuthService.issueToken({ userId: 'alice', githubId: '7' });
    const other = AuthService.issueToken({ userId: 'alice', githubId: '7' });
    expect(first).not.toBe(other);
    await expect(AuthService.verifySession(first)).resolves.toMatchObject({ userId: 'alice' });
    await AuthService.revokeToken(first);
    await expect(AuthService.verifySession(first)).rejects.toThrow('Session revoked');
    await expect(AuthService.verifySession(other)).resolves.toMatchObject({ userId: 'alice' });
    expect(store.rows.has(sessionHash(first))).toBe(true);
    expect(JSON.stringify([...store.rows])).not.toContain(first);
  });
  it('fails closed when the revocation store cannot be read or written', async () => {
    const token = AuthService.issueToken({ userId: 'alice', githubId: '7' });
    store.unavailable = true;
    await expect(AuthService.verifySession(token)).rejects.toBeInstanceOf(SessionUnavailableError);
    await expect(AuthService.revokeToken(token)).rejects.toBeInstanceOf(SessionUnavailableError);
  });
  it('does not create records from forged tokens', async () => {
    await AuthService.revokeToken('forged');
    expect(store.rows.size).toBe(0);
    await expect(AuthService.verifySession('forged')).rejects.toThrow();
  });
});
