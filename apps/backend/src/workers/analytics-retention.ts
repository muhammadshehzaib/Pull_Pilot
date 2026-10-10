import prisma from '../config/prisma';

export async function sweepAnalyticsOnce() {
  const rows = await prisma.reviewAnalyticsFact.findMany({ where: { expiresAt: { lte: new Date() } },
    select: { id: true }, orderBy: { expiresAt: 'asc' }, take: 500 });
  if (!rows.length) return 0;
  return (await prisma.reviewAnalyticsFact.deleteMany({ where: { id: { in: rows.map(r => r.id) } } })).count;
}
export function startAnalyticsRetentionSweep() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await sweepAnalyticsOnce(); }
    catch { console.warn('[Analytics] Retention unavailable; will retry.'); }
    finally { running = false; }
  };
  void tick(); setInterval(tick, 60_000).unref();
}
