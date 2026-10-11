import { Queue } from 'bullmq';
import { redisConnection } from './redis';
import { ANALYSIS_QUEUE_NAME, FAILED_JOB_RETENTION_SECONDS } from '../utils/constants';

export const analysisQueue = new Queue(ANALYSIS_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3, // Retry up to 3 times if failing
    backoff: {
      type: 'review',
      delay: 1000, // Wait 1s, then 2s, then 4s
    },
    removeOnComplete: true, // Clean up redis memory automatically
    // Failed jobs are kept for JOB_RETENTION_DAYS so they can be inspected, then
    // BullMQ drops them on its own. `false` here would retain every failed
    // payload (full diff + AI response) forever, growing Redis without bound.
    removeOnFail: { age: FAILED_JOB_RETENTION_SECONDS },
  },
});

console.log(`📦 BullMQ Queue [${ANALYSIS_QUEUE_NAME}] Initialized`);
