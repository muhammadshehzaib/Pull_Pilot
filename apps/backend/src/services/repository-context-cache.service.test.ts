import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCachedFile, mockPrisma, ENCRYPTION_KEY } = vi.hoisted(() => {
  const mockCachedFile = {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  };
  // The worker instantiates PrismaClient on import; keep tests off a real DB.
  const mockPrisma = {
    cachedFile: mockCachedFile,
  };
  return {
    mockCachedFile,
    mockPrisma,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? '',
  };
});

vi.mock('../config/prisma', () => ({ default: mockPrisma }));

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test_encryption_key_at_least_16_chars';

import { RepositoryContextCache } from './repository-context-cache.service';
import { EncryptionService } from './encryption.service';

const REPO = 'repo-1';
const SHA = 'blob-sha-1';

describe('RepositoryContextCache', () => {
  let cache: RepositoryContextCache;

  beforeEach(() => {
    vi.clearAllMocks();
    cache = new RepositoryContextCache();
    mockCachedFile.delete.mockResolvedValue({ count: 1 });
    mockCachedFile.deleteMany.mockResolvedValue({ count: 0 });
  });

  describe('isContextCandidate()', () => {
    it('accepts JS/TS source files', () => {
      for (const p of ['src/a.ts', 'src/b.tsx', 'c.js', 'd.jsx', 'e.mts', 'f.cjs']) {
        expect(RepositoryContextCache.isContextCandidate(p, 1000)).toBe(true);
      }
    });

    it('rejects files that are too large to be worth sending', () => {
      expect(RepositoryContextCache.isContextCandidate('src/huge.ts', 10_000_000)).toBe(false);
    });

    it('rejects non-source files', () => {
      for (const p of ['README.md', 'style.css', 'data.json', 'image.png', 'Makefile']) {
        expect(RepositoryContextCache.isContextCandidate(p, 1000)).toBe(false);
      }
    });

    it('rejects vendored and build directories at any depth', () => {
      const skipped = [
        'node_modules/x/index.ts',
        'packages/app/node_modules/y/index.js',
        'dist/main.js',
        'coverage/lcov-report/x.js',
        '.next/server/page.js',
        'vendor/lib/helper.ts',
      ];
      for (const p of skipped) {
        expect(RepositoryContextCache.isContextCandidate(p, 1000)).toBe(false);
      }
    });

    it('rejects hidden directories but keeps legitimate dot-prefixed filenames', () => {
      expect(RepositoryContextCache.isContextCandidate('.github/scripts/run.ts', 1000)).toBe(false);
      expect(RepositoryContextCache.isContextCandidate('src/.eslintrc.js', 1000)).toBe(true);
    });
  });

  describe('put()', () => {
    it('stores an encrypted envelope, never plaintext', async () => {
      const secret = 'const apiKey = "sk-super-secret";';
      await cache.put(REPO, SHA, 'src/a.ts', secret);

      const call = mockCachedFile.upsert.mock.calls[0][0];
      const row = call.create;

      expect(row.repositoryId).toBe(REPO);
      expect(row.blobSha).toBe(SHA);
      expect(row.encryptedData).not.toContain('sk-super-secret');
      expect(row.encryptedData).toEqual(expect.any(String));
      expect(row.iv).toEqual(expect.any(String));
      expect(row.authTag).toEqual(expect.any(String));
      expect(row.salt).toEqual(expect.any(String));
    });

    it('records an absolute expiry in the future', async () => {
      const before = Date.now();
      await cache.put(REPO, SHA, 'src/a.ts', 'x');

      const { expiresAt } = mockCachedFile.upsert.mock.calls[0][0].create;
      expect(expiresAt.getTime()).toBeGreaterThan(before);
    });

    it('records byte length for multi-byte content', async () => {
      await cache.put(REPO, SHA, 'src/a.ts', 'const x = "🎯";');
      const { sizeBytes } = mockCachedFile.upsert.mock.calls[0][0].create;
      // "🎯" is 4 bytes in UTF-8, not 2 JS characters.
      expect(sizeBytes).toBe(Buffer.byteLength('const x = "🎯";', 'utf-8'));
    });

    it('skips the write when a live row already exists', async () => {
      mockCachedFile.findUnique.mockResolvedValueOnce({
        id: 'row-1',
        expiresAt: new Date(Date.now() + 60_000),
      });

      await cache.put(REPO, SHA, 'src/a.ts', 'x');

      expect(mockCachedFile.upsert).not.toHaveBeenCalled();
    });

    it('refreshes an expired row rather than leaving it stale', async () => {
      mockCachedFile.findUnique.mockResolvedValueOnce({
        id: 'row-1',
        expiresAt: new Date(Date.now() - 1_000),
      });

      await cache.put(REPO, SHA, 'src/a.ts', 'x');

      const call = mockCachedFile.upsert.mock.calls[0][0];
      expect(call.update.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('get()', () => {
    it('returns decrypted content on a hit', async () => {
      const plain = 'export const answer = 42;';
      const sealed = EncryptionService.encrypt(plain);
      mockCachedFile.findUnique.mockResolvedValueOnce({
        id: 'row-1',
        encryptedData: sealed.encryptedData,
        iv: sealed.iv,
        authTag: sealed.authTag,
        salt: sealed.salt,
        expiresAt: new Date(Date.now() + 60_000),
      });

      await expect(cache.get(REPO, SHA)).resolves.toBe(plain);
    });

    it('returns null on a miss', async () => {
      mockCachedFile.findUnique.mockResolvedValueOnce(null);
      await expect(cache.get(REPO, SHA)).resolves.toBeNull();
    });

    it('discards and deletes an expired row instead of returning it', async () => {
      mockCachedFile.findUnique.mockResolvedValueOnce({
        id: 'row-1',
        encryptedData: 'x',
        iv: 'y',
        authTag: 'z',
        salt: 's',
        expiresAt: new Date(Date.now() - 1_000),
      });

      await expect(cache.get(REPO, SHA)).resolves.toBeNull();
      expect(mockCachedFile.delete).toHaveBeenCalledWith({ where: { id: 'row-1' } });
    });

    it('drops a row it cannot decrypt, so a rotated key is refetched', async () => {
      mockCachedFile.findUnique.mockResolvedValueOnce({
        id: 'row-1',
        encryptedData: 'garbage',
        iv: 'y',
        authTag: 'z',
        salt: 's',
        expiresAt: new Date(Date.now() + 60_000),
      });

      await expect(cache.get(REPO, SHA)).resolves.toBeNull();
      expect(mockCachedFile.delete).toHaveBeenCalledWith({ where: { id: 'row-1' } });
    });

    it('scopes the lookup to the repository so blobs are never shared across repos', async () => {
      mockCachedFile.findUnique.mockResolvedValueOnce(null);

      await cache.get('repo-A', SHA);

      expect(mockCachedFile.findUnique).toHaveBeenCalledWith({
        where: { repositoryId_blobSha: { repositoryId: 'repo-A', blobSha: SHA } },
      });
    });
  });

  describe('sweepExpired()', () => {
    it('deletes only rows past their expiry and reports the count', async () => {
      mockCachedFile.deleteMany.mockResolvedValueOnce({ count: 7 });

      await expect(cache.sweepExpired()).resolves.toBe(7);

      const where = mockCachedFile.deleteMany.mock.calls[0][0].where;
      expect(where.expiresAt.lte.getTime()).toBeLessThanOrEqual(Date.now());
    });
  });
});