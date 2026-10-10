import type { Prisma } from '@prisma/client';

export const HISTORY_DAYS = 90;
export const RECURRING_PR_THRESHOLD = 3;
export const HISTORY_MAX_AGE_MS = 60 * 60 * 1000;
export const historyCutoff = () => new Date(Date.now() - HISTORY_DAYS * 86400000);

/** Every history mutation/rebuild takes this lock first, in the same order. */
export async function lockHistoricalRepository(tx: Prisma.TransactionClient, repositoryId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM repositories WHERE id = ${repositoryId} FOR UPDATE
  `;
  if (!rows.length) throw new Error('Repository unavailable');
}

export async function dirtyHistory(tx: Prisma.TransactionClient, repositoryId: string) {
  await tx.repository.update({ where: { id: repositoryId }, data: { historicalRevision: { increment: 1 } } });
  // Eager invalidation also protects readers already in flight during mutation.
  await tx.historicalPattern.deleteMany({ where: { repositoryId } });
}
