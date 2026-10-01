import prisma from '../config/prisma';

const RETENTION_DAYS = parseInt(process.env.JOB_RETENTION_DAYS || '7', 10);
const SWEEP_INTERVAL_MS = parseInt(process.env.JOB_SWEEP_INTERVAL_MS || '21600000', 10); // 6h
const SWEEP_ENABLED = process.env.JOB_RETENTION_SWEEP !== 'false';

const DELETE_BATCH_SIZE = 500;

/**
 * Deletes FAILED analysis_jobs rows older than JOB_RETENTION_DAYS.
 *
 * Only FAILED is swept. COMPLETED rows are the review history users browse in
 * /history, and QUEUED/RUNNING may still be live, so neither is touched. FAILED
 * is terminal — analysis.worker.ts already set the status and stored the error
 * before rethrowing — so an aged-out row loses nothing that matters.
 *
 * Runs in batches so a large backlog cannot build one enormous DELETE.
 * Returns the number of rows removed.
 */
export async function sweepFailedJobsOnce(retentionDays = RETENTION_DAYS): Promise<number> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  let total = 0;

  for (;;) {
    const stale = await prisma.analysisJob.findMany({
      where: { status: 'FAILED', updatedAt: { lt: cutoff } },
      select: { id: true },
      orderBy: { updatedAt: 'asc' },
      take: DELETE_BATCH_SIZE,
    });

    if (stale.length === 0) break;

    // deleteMany on the ids we just selected; a concurrent worker moving a row out
    // of FAILED simply means fewer rows match, which is harmless here.
    const { count } = await prisma.analysisJob.deleteMany({
      where: { id: { in: stale.map((j) => j.id) } },
    });

    total += count;
    if (stale.length < DELETE_BATCH_SIZE) break;
  }

  return total;
}

export function startJobRetentionSweep(): void {
  if (!SWEEP_ENABLED) {
    console.log('🧹 Job retention sweep disabled (JOB_RETENTION_SWEEP=false).');
    return;
  }

  let sweeping = false;

  const tick = async () => {
    if (sweeping) return; // don't overlap slow sweeps
    sweeping = true;
    try {
      const removed = await sweepFailedJobsOnce();
      if (removed > 0) {
        console.log(`🧹 Retention sweep removed ${removed} failed job(s) older than ${RETENTION_DAYS}d.`);
      }
    } catch (err) {
      console.error('⚠️  Job retention sweep failed:', err);
    } finally {
      sweeping = false;
    }
  };

  setInterval(tick, SWEEP_INTERVAL_MS).unref();
  void tick();
  console.log(
    `🧹 Job retention sweep active (every ${Math.round(SWEEP_INTERVAL_MS / 60000)}m): failed jobs are kept ${RETENTION_DAYS}d.`,
  );
}
