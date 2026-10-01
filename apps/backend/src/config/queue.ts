import { Queue } from 'bullmq';
import { redisConnection } from './redis';

export const ANALYSIS_QUEUE_NAME = 'code-analysis-queue';

// Failed jobs are kept for 7 days so they can be inspected, then BullMQ drops them
// on its own. `false` here would retain every failed payload (full diff + AI
// response) forever, which grows Redis without bound.
const FAILED_JOB_RETENTION_DAYS = parseInt(process.env.JOB_RETENTION_DAYS || '7', 10);

export const analysisQueue = new Queue(ANALYSIS_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3, // Retry up to 3 times if failing
    backoff: {
      type: 'exponential',
      delay: 1000, // Wait 1s, then 2s, then 4s
    },
    removeOnComplete: true, // Clean up redis memory automatically
    removeOnFail: { age: FAILED_JOB_RETENTION_DAYS * 24 * 60 * 60 },
  },
});

console.log(`📦 BullMQ Queue [${ANALYSIS_QUEUE_NAME}] Initialized`);
