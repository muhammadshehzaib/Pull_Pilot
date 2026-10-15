import { redisConnection } from '../config/redis';

const CHANNEL = 'aipr:review-progress:v1';
export interface ReviewProgress { userId: string; jobId: string; message: string; status: string; data?: unknown }

export function parseReviewProgress(text: string): ReviewProgress | null {
  if (text.length > 128000) return null;
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object') return null;
    for (const field of ['userId', 'jobId', 'message', 'status']) {
      if (typeof value[field] !== 'string' || !value[field] || value[field].length > (field === 'message' ? 16000 : 200)) return null;
    }
    return { userId: value.userId, jobId: value.jobId, message: value.message, status: value.status, data: value.data };
  } catch { return null; }
}

export async function publishReviewProgress(progress: ReviewProgress) {
  const encoded = JSON.stringify(progress);
  if (!parseReviewProgress(encoded)) throw new Error('Invalid review progress');
  await redisConnection.publish(CHANNEL, encoded);
}

export async function subscribeReviewProgress(receive: (progress: ReviewProgress) => Promise<void>) {
  const subscriber = redisConnection.duplicate();
  subscriber.on('error', () => console.error('Review progress subscription unavailable'));
  subscriber.on('message', (channel, text) => {
    if (channel !== CHANNEL) return;
    const progress = parseReviewProgress(text);
    if (progress) void receive(progress).catch(() => console.error('Review progress delivery failed'));
  });
  await subscriber.subscribe(CHANNEL);
  return subscriber;
}
