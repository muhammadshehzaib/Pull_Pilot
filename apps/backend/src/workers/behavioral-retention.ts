import prisma from '../config/prisma';

export async function sweepBehavioralOnce(now = new Date()) {
  const timedOut = await prisma.behavioralRun.updateMany({ where: { status: { in: ['QUEUED', 'RUNNING'] }, deadlineAt: { lte: now } }, data: { status: 'TIMED_OUT', reason: 'CI_DEADLINE_EXCEEDED' } });
  // Bounded batches keep a large retention backlog off the request path.
  const expired = await prisma.behavioralRun.findMany({ where: { expiresAt: { lte: now } }, select: { id: true }, take: 200, orderBy: { expiresAt: 'asc' } });
  if (expired.length) await prisma.behavioralRun.deleteMany({ where: { id: { in: expired.map(r => r.id) }, expiresAt: { lte: now } } });
  return { timedOut: timedOut.count, deleted: expired.length };
}
export function startBehavioralRetentionSweep() {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await sweepBehavioralOnce(); }
    catch { console.warn('Behavioral retention sweep unavailable'); }
    finally { busy = false; }
  };
  setInterval(tick, 60_000).unref();
  void tick();
}
