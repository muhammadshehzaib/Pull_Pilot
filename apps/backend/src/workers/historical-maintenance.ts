import prisma from '../config/prisma';
import { aggregateRepositoryPatterns } from '../services/historical/aggregation.service';
import { dirtyHistory, historyCutoff, lockHistoricalRepository, HISTORY_MAX_AGE_MS } from '../services/historical/state';

/** One bounded pass. DB revision mismatch is durable pending work, not a fire-and-forget promise. */
export async function sweepHistoricalOnce() {
  const oldAudit = await prisma.ruleAuditEvent.findMany({ where: { createdAt: { lt: historyCutoff() } },
    select: { id: true }, orderBy: { createdAt: 'asc' }, take: 500 });
  if (oldAudit.length) await prisma.ruleAuditEvent.deleteMany({ where: { id: { in: oldAudit.map(row => row.id) } } });
  const expired = await prisma.findingOccurrence.findMany({
    where: { OR: [ { createdAt: { lt: historyCutoff() } },
      { analysisJob: { createdAt: { lt: historyCutoff() } } }, { repository: { isActive: false } } ] },
    select: { id: true, repositoryId: true }, orderBy: { createdAt: 'asc' }, take: 500,
  });
  for (const repositoryId of new Set(expired.map(row => row.repositoryId))) {
    await prisma.$transaction(async tx => {
      await lockHistoricalRepository(tx, repositoryId);
      await tx.findingOccurrence.deleteMany({ where: { repositoryId,
        id: { in: expired.filter(row => row.repositoryId === repositoryId).map(row => row.id) } } });
      await dirtyHistory(tx, repositoryId);
    });
  }
  const due = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM repositories WHERE "isActive" = true AND
      ("historicalRevision" <> "historicalAggregatedRevision" OR
       "historicalAggregatedAt" IS NULL OR "historicalAggregatedAt" < ${new Date(Date.now() - HISTORY_MAX_AGE_MS)} OR
       EXISTS (SELECT 1 FROM historical_patterns p WHERE p."repositoryId" = repositories.id AND p."expiresAt" <= ${new Date()}))
    ORDER BY "historicalAggregatedAt" ASC NULLS FIRST LIMIT 10
  `;
  for (const repo of due) {
    try { await aggregateRepositoryPatterns(repo.id); }
    catch { console.warn('[Phase8] Historical rebuild pending; maintenance will retry'); }
  }
  return expired.length;
}

export async function clearRepositoryHistory(repositoryId: string) {
  await prisma.$transaction(async tx => {
    await lockHistoricalRepository(tx, repositoryId);
    await tx.findingOccurrence.deleteMany({ where: { repositoryId } });
    await dirtyHistory(tx, repositoryId);
    await tx.ruleAuditEvent.deleteMany({ where: { repositoryId } });
    await tx.reviewAnalyticsFact.deleteMany({ where: { repositoryId } });
    await tx.repository.update({ where: { id: repositoryId }, data: { historicalIntelligenceEnabled: false,
      feedbackAdaptationEnabled: false, feedbackAdaptationRevision: { increment: 1 }, analyticsStartedAt: new Date() } });
  });
}

export function startHistoricalMaintenance() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await sweepHistoricalOnce(); }
    catch { console.warn('[Phase8] Historical maintenance unavailable; will retry'); }
    finally { running = false; }
  };
  void tick();
  setInterval(tick, 60_000).unref();
}
