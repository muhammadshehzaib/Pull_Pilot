import prisma from '../config/prisma';
import {
  CONTEXT_RETAIN_INDEFINITELY,
  CONTEXT_RETENTION_HOURS,
  CONTEXT_SWEEP_ENABLED,
  DELETE_BATCH_SIZE,
} from '../utils/constants';

/**
 * Deletes cached_file rows whose retention window has elapsed.
 *
 * This is what makes the retention promise real. Cached rows hold customer
 * source code, so the window is short and every row carries an absolute
 * expiresAt; without this sweep the cache would quietly become a mirror of
 * every repository PullPilot has ever reviewed.
 *
 * Sweeping by expiresAt also deletes rows that were never read again, which is
 * the common case: a blob fetched for one review is usually untouched by the
 * next. Expiry is decided at write time, so this is a single indexed scan and
 * needs no recomputation.
 *
 * Runs in batches so a large backlog cannot build one enormous DELETE.
 * Returns the number of rows removed.
 */
export async function sweepExpiredContextOnce(): Promise<number> {
  const now = new Date();
  let total = 0;
  if (!CONTEXT_RETAIN_INDEFINITELY) {
    const data = { expiresAt: new Date(now.getTime() + CONTEXT_RETENTION_HOURS * 3_600_000) };
    await prisma.cachedFile.updateMany({ where: { expiresAt: null }, data });
    await prisma.cachedImport.updateMany({ where: { expiresAt: null }, data });
  }

  for (;;) {
    const expired = await prisma.cachedFile.findMany({
      where: { expiresAt: { lte: now } },
      select: { id: true },
      orderBy: { expiresAt: 'asc' },
      take: DELETE_BATCH_SIZE,
    });

    if (expired.length === 0) break;

    // deleteMany on the ids we just selected. A concurrent read does not
    // extend a row's expiry, so this is safe to repeat.
    const { count } = await prisma.cachedFile.deleteMany({
      where: { id: { in: expired.map((f) => f.id) } },
    });

    total += count;
    if (expired.length < DELETE_BATCH_SIZE) break;
  }

  for (;;) {
    const expired = await prisma.cachedImport.findMany({
      where: { expiresAt: { lte: now } }, select: { id: true },
      orderBy: { expiresAt: 'asc' }, take: DELETE_BATCH_SIZE,
    });
    if (!expired.length) break;
    const { count } = await prisma.cachedImport.deleteMany({ where: { id: { in: expired.map(row => row.id) } } });
    total += count;
    if (expired.length < DELETE_BATCH_SIZE) break;
  }
  return total;
}

export function startContextRetentionSweep(): void {
  if (!CONTEXT_SWEEP_ENABLED) {
    console.log('🧹 Review context sweep disabled (CONTEXT_SWEEP_ENABLED=false).');
    return;
  }

  let sweeping = false;

  const tick = async () => {
    if (sweeping) return; // don't overlap slow sweeps
    sweeping = true;
    try {
      const removed = await sweepExpiredContextOnce();
      if (removed > 0) {
        console.log(`🧹 Context sweep deleted ${removed} expired file(s).`);
      }
    } catch (err) {
      console.error('⚠️  Context retention sweep failed:', err);
    } finally {
      sweeping = false;
    }
  };

  // Hourly: the shortest window we allow is hours, not days, and these rows
  // are large encrypted payloads that should not linger past their window.
  // With indefinite retention the sweep is still started, because it collects
  // rows written under an earlier expiry policy after the setting changes.
  setInterval(tick, 60 * 60 * 1000).unref();
  void tick();
  console.log(
    CONTEXT_RETAIN_INDEFINITELY
      ? '🧹 Review context sweep active (hourly): cached file content is kept until its repository is disconnected.'
      : `🧹 Review context sweep active (hourly): cached file content is kept ${CONTEXT_RETENTION_HOURS}h.`,
  );
}
