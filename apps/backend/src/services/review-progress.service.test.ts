import { describe, expect, it, vi } from 'vitest';
const bus = vi.hoisted(() => ({ publish: vi.fn(), subscribe: vi.fn(), handlers: new Map<string, Function>() }));
vi.mock('../config/redis', () => ({ redisConnection: {
  publish: bus.publish, duplicate: () => ({ subscribe: bus.subscribe, on: (name: string, fn: Function) => bus.handlers.set(name, fn) }),
} }));
import { parseReviewProgress, publishReviewProgress, subscribeReviewProgress } from './review-progress.service';

describe('separate worker progress transport', () => {
  it('preserves trusted job ownership between worker publication and API subscription', async () => {
    const progress = { userId: 'alice', jobId: 'alice-job', message: 'Analyzing', status: 'ANALYZING' };
    const receive = vi.fn(async () => {});
    await subscribeReviewProgress(receive);
    await publishReviewProgress(progress);
    const [channel, text] = bus.publish.mock.calls[0];
    bus.handlers.get('message')!(channel, text);
    expect(receive).toHaveBeenCalledWith({ ...progress, data: undefined });
    bus.handlers.get('message')!('foreign-channel', text);
    bus.handlers.get('message')!(channel, '{invalid json');
    expect(receive).toHaveBeenCalledTimes(1);
  });
  it.each(['{}', 'null', '{"userId":7}', 'x'.repeat(128001)])('rejects malformed or oversized envelopes: %#', text => {
    expect(parseReviewProgress(text)).toBeNull();
  });
});
