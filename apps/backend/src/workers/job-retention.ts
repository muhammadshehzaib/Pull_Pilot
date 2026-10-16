import prisma from '../config/prisma';
import {
  DELETE_BATCH_SIZE,
  JOB_RETENTION_DAYS,
  SWEEP_ENABLED,
  SWEEP_INTERVAL_MS,
} from '../utils/constants';

/**
 * Deletes FAILED analysis_jobs rows older than JOB_RETENTION_DAYS.
 *
 * Only FAILED is swept. COMPLETED rows are the review history users browse in
 * /history, and QUEUED/RUNNING may still be live, so neither is touched. FAILED
 * jobs with a delivery plan are retained: their unique review identity and
 * receipts prevent a reopened PR from posting the same comments again.
 *
 * Runs in batches so a large backlog cannot build one enormous DELETE.
 * Returns the number of rows removed.
 */
export async function sweepFailedJobsOnce(retentionDays = JOB_RETENTION_DAYS): Promise<number> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  let total = 0;

  for (;;) {
    const stale = await prisma.analysisJob.findMany({
      where: { status: 'FAILED', updatedAt: { lt: cutoff }, deliveryPlan: { is: null } },
      select: { id: true },
      orderBy: { updatedAt: 'asc' },
      take: DELETE_BATCH_SIZE,
    });

    if (stale.length === 0) break;

    // deleteMany on the ids we just selected; a concurrent worker moving a row out
    // of FAILED simply means fewer rows match, which is harmless here.
    const { count } = await prisma.analysisJob.deleteMany({
      where: { id: { in: stale.map((j) => j.id) }, status: 'FAILED', updatedAt: { lt: cutoff }, deliveryPlan: { is: null } },
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
        console.log(`🧹 Retention sweep removed ${removed} failed job(s) older than ${JOB_RETENTION_DAYS}d.`);
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
    `🧹 Job retention sweep active (every ${Math.round(SWEEP_INTERVAL_MS / 60000)}m): failed jobs are kept ${JOB_RETENTION_DAYS}d.`,
  );
}
