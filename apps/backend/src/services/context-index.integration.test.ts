import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

const url = process.env.CONTEXT_TEST_DATABASE_URL;
describe.skipIf(!url)('repository import cache PostgreSQL integration', () => {
  let prisma: typeof import('../config/prisma').default;
  let cache: InstanceType<typeof import('./repository-import-index.service').RepositoryImportCache>;
  let source: InstanceType<typeof import('./repository-context-cache.service').RepositoryContextCache>;
  const owner = randomUUID();
  let repositoryId: string;
  let otherId: string;
  const value = { specifiers: ['./payment'], barrel: false, unsupported: false };
  beforeAll(async () => {
    const target = new URL(url!);
    if (!['localhost', '127.0.0.1'].includes(target.hostname) || !target.pathname.endsWith('_test') || process.env.DATABASE_URL !== url) {
      throw new Error('Context integration tests require an explicitly selected local disposable *_test database');
    }
    prisma = (await import('../config/prisma')).default;
    const { RepositoryImportCache } = await import('./repository-import-index.service');
    const { RepositoryContextCache } = await import('./repository-context-cache.service');
    cache = new RepositoryImportCache(60_000); source = new RepositoryContextCache(60_000);
    process.env.ENCRYPTION_KEY ||= 'context_integration_test_key_long_enough';
    await prisma.user.create({ data: { id: owner, githubId: owner, username: 'context-test' } });
    repositoryId = (await prisma.repository.create({ data: { userId: owner, githubRepoId: BigInt(Date.now()), fullName: 'context/disposable' } })).id;
    otherId = (await prisma.repository.create({ data: { userId: owner, githubRepoId: BigInt(Date.now() + 1), fullName: 'context/other' } })).id;
  });
  afterAll(async () => {
    if (repositoryId) await prisma.user.delete({ where: { id: owner } });
    if (prisma) await prisma.$disconnect();
  });
  it('upserts concurrent writes once and isolates identical blobs between repositories', async () => {
    await Promise.all([cache.put(repositoryId, 'sha', value), cache.put(repositoryId, 'sha', value)]);
    expect(await prisma.cachedImport.count({ where: { repositoryId, blobSha: 'sha' } })).toBe(1);
    const row = await prisma.cachedImport.findFirstOrThrow({ where: { repositoryId } });
    expect(JSON.stringify(row)).not.toContain('./payment');
    expect((await cache.getMany(repositoryId, ['sha'], new AbortController().signal)).get('sha')).toEqual(value);
    expect((await cache.getMany(otherId, ['sha'], new AbortController().signal)).size).toBe(0);
  });
  it('rejects expired records and incompatible parser versions', async () => {
    await prisma.cachedImport.updateMany({ where: { repositoryId }, data: { expiresAt: new Date(0) } });
    expect((await cache.getMany(repositoryId, ['sha'], new AbortController().signal)).size).toBe(0);
    await prisma.cachedImport.updateMany({ where: { repositoryId }, data: { expiresAt: null, parserVersion: 999 } });
    expect((await cache.getMany(repositoryId, ['sha'], new AbortController().signal)).size).toBe(0);
  });
  it('clears both caches on disconnect and prevents late writes from recreating them', async () => {
    await source.put(repositoryId, 'source', 'src/payment.ts', 'export const pay = 1;');
    await prisma.repository.update({ where: { id: repositoryId }, data: { isActive: false } });
    await source.clearRepository(repositoryId);
    await Promise.all([cache.put(repositoryId, 'late', value), source.put(repositoryId, 'late', 'src/x.ts', '')]);
    expect(await prisma.cachedImport.count({ where: { repositoryId } })).toBe(0);
    expect(await prisma.cachedFile.count({ where: { repositoryId } })).toBe(0);
  });
  it('sweeps expired source and import records under the shared retention lifecycle', async () => {
    await cache.put(otherId, 'expired', value);
    await source.put(otherId, 'expired', 'src/payment.ts', '');
    await prisma.cachedImport.updateMany({ where: { repositoryId: otherId }, data: { expiresAt: new Date(0) } });
    await prisma.cachedFile.updateMany({ where: { repositoryId: otherId }, data: { expiresAt: new Date(0) } });
    const { sweepExpiredContextOnce } = await import('../workers/context-retention');
    expect(await sweepExpiredContextOnce()).toBeGreaterThanOrEqual(2);
    expect(await prisma.cachedImport.count({ where: { repositoryId: otherId } })).toBe(0);
    expect(await prisma.cachedFile.count({ where: { repositoryId: otherId } })).toBe(0);
  });
  it('repository deletion cascades its parsed imports', async () => {
    await cache.put(otherId, 'sha', value);
    await prisma.repository.delete({ where: { id: otherId } });
    expect(await prisma.cachedImport.count({ where: { repositoryId: otherId } })).toBe(0);
  });
});
