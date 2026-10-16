import { redisConnection } from '../config/redis';

export const POLLER_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const pollerHeadKey = (repositoryId: string, prNumber: number) => `pr-poll-head:v2:${repositoryId}:${prNumber}`;

/** One incremental SCAN page; NX does not extend keys that already expire. */
export async function expireLegacyPollerCacheOnce(cursor = '0'): Promise<string> {
  const [next, keys] = await redisConnection.scan(cursor, 'MATCH', 'pr-scanned:*', 'COUNT', 100);
  // SCAN's COUNT is a hint, so bound command concurrency independently.
  for (let offset = 0; offset < keys.length; offset += 20) {
    await Promise.all(keys.slice(offset, offset + 20).map(key => redisConnection.expire(key, POLLER_CACHE_TTL_SECONDS, 'NX')));
  }
  return next;
}

/** Also runs with GitHub polling disabled; stops after the legacy keyspace pass. */
export function startLegacyPollerCacheExpiry() {
  let cursor = '0', running = false, stopped = false;
  const stop = () => { stopped = true; clearInterval(timer); };
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      cursor = await expireLegacyPollerCacheOnce(cursor);
      if (cursor === '0') stop();
    } catch {
      console.warn('Legacy poller cache expiry pending; retrying on the next maintenance check');
    } finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, 60_000);
  timer.unref();
  void tick();
  return stop;
}
