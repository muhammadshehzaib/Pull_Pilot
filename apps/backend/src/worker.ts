import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

async function startWorker() {
  const { default: prisma } = await import('./config/prisma');
  await prisma.$connect();
  await import('./workers/analysis.worker');
  const tasks = await Promise.all([
    import('./workers/repo-poller'), import('./workers/job-retention'),
    import('./workers/context-retention'), import('./workers/behavioral-retention'),
    import('./workers/historical-maintenance'), import('./workers/analytics-retention'),
    import('./workers/review-recovery'),
  ]);
  tasks[0].startRepoPoller(); tasks[1].startJobRetentionSweep();
  tasks[2].startContextRetentionSweep(); tasks[3].startBehavioralRetentionSweep();
  tasks[4].startHistoricalMaintenance(); tasks[5].startAnalyticsRetentionSweep();
  tasks[6].startReviewRecovery();
  console.log('Review worker started in a separate process');
}
void startWorker().catch(() => { console.error('Review worker failed to start'); process.exitCode = 1; });
