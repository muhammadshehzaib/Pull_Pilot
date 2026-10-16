import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { scan, expire } = vi.hoisted(() => ({ scan: vi.fn(), expire: vi.fn() }));
vi.mock('../config/redis', () => ({ redisConnection: { scan, expire } }));
import { expireLegacyPollerCacheOnce, startLegacyPollerCacheExpiry, pollerHeadKey, POLLER_CACHE_TTL_SECONDS } from './poller-cache';

beforeEach(() => { vi.resetAllMocks(); scan.mockResolvedValue(['0', []]); expire.mockResolvedValue(1); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('poller cache lifecycle', () => {
  it('keeps one slot per PR and separates repositories and PR numbers', () => {
    expect(pollerHeadKey('one', 7)).toBe('pr-poll-head:v2:one:7');
    expect(pollerHeadKey('two', 7)).not.toBe(pollerHeadKey('one', 7));
    expect(pollerHeadKey('one', 8)).not.toBe(pollerHeadKey('one', 7));
  });
  it('incrementally expires legacy keys without renewing existing expiries', async () => {
    scan.mockResolvedValueOnce(['123', ['pr-scanned:r:7:old', 'pr-scanned:r:7:new']]);
    expect(await expireLegacyPollerCacheOnce('9')).toBe('123');
    expect(scan).toHaveBeenCalledWith('9', 'MATCH', 'pr-scanned:*', 'COUNT', 100);
    expect(expire.mock.calls).toEqual([
      ['pr-scanned:r:7:old', POLLER_CACHE_TTL_SECONDS, 'NX'],
      ['pr-scanned:r:7:new', POLLER_CACHE_TTL_SECONDS, 'NX'],
    ]);
  });
  it('limits expiry-command concurrency even when Redis returns a large SCAN page', async () => {
    const keys = Array.from({ length: 237 }, (_, i) => `pr-scanned:r:7:${i}`);
    scan.mockResolvedValueOnce(['0', keys]);
    let active = 0, peak = 0;
    expire.mockImplementation(async () => { active++; peak = Math.max(peak, active); await Promise.resolve(); active--; return 1; });
    await expireLegacyPollerCacheOnce();
    expect(peak).toBeLessThanOrEqual(20); expect(expire).toHaveBeenCalledTimes(237);
  });
  it('continues one page per minute and stops after the pass, independently of GitHub polling', async () => {
    vi.useFakeTimers(); scan.mockResolvedValueOnce(['100', []]).mockResolvedValueOnce(['0', ['pr-scanned:r:7:x']]);
    startLegacyPollerCacheExpiry();
    await vi.advanceTimersByTimeAsync(0); expect(scan).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000); expect(scan.mock.calls[1]![0]).toBe('100');
    await vi.advanceTimersByTimeAsync(180_000); expect(scan).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it('handles Redis outages and retries the same page without extending expired keys', async () => {
    vi.useFakeTimers(); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    scan.mockResolvedValue(['100', ['pr-scanned:r:7:x']]);
    expire.mockRejectedValueOnce(new Error('private Redis URL')).mockResolvedValue(1);
    const stop = startLegacyPollerCacheExpiry();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scan.mock.calls.map(call => call[0])).toEqual(['0', '0']);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private Redis URL');
    stop();
  });
});
