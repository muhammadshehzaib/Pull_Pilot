import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
async function config(enabled?: string, interval?: string) {
  vi.stubEnv('REPO_POLL_ENABLED', enabled); vi.stubEnv('REPO_POLL_INTERVAL_MS', interval);
  vi.resetModules();
  return import('./constants');
}

describe('development polling configuration', () => {
  it.each([undefined, '', 'false', 'TRUE', '1', 'yes'])('keeps polling off for %s', async value => {
    expect((await config(value)).POLL_ENABLED).toBe(false);
  });
  it('enables polling only through explicit true', async () => {
    expect((await config('true')).POLL_ENABLED).toBe(true);
  });
  it.each([undefined, '', 'NaN', '-1', '0', '1', '59999', '60000junk', '60000.5', 'Infinity', '2147483648'])
    ('uses a safe interval for invalid or too-short input %s', async value => {
      expect((await config(undefined, value)).POLL_INTERVAL_MS).toBe(60_000);
    });
  it.each(['60000', '120000', '2147483647'])('accepts valid timer interval %s', async value => {
    expect((await config('true', value)).POLL_INTERVAL_MS).toBe(Number(value));
  });
});
