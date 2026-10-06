import { describe, it, expect, vi } from 'vitest';

/**
 * analytics.ts reads its configuration from the environment at import time,
 * so each case reloads the module with the env it wants to exercise.
 */
async function load(env: { src?: string; id?: string }) {
  vi.resetModules();
  if (env.src === undefined) delete process.env.NEXT_PUBLIC_UMAMI_SRC;
  else process.env.NEXT_PUBLIC_UMAMI_SRC = env.src;

  if (env.id === undefined) delete process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID;
  else process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID = env.id;

  return import('./analytics');
}

const SRC = 'https://analytics.example.com/script.js';
const ID = '4fd14c41-b3d3-4442-9fa2-2dd11b10c437';

describe('analytics config', () => {
  it('enables analytics when an https tracker and a website id are present', async () => {
    const m = await load({ src: SRC, id: ID });
    expect(m.ANALYTICS_ENABLED).toBe(true);
    expect(m.ANALYTICS_ORIGIN).toBe('https://analytics.example.com');
    expect(m.ANALYTICS_SCRIPT_SRC).toBe(SRC);
    expect(m.ANALYTICS_WEBSITE_ID).toBe(ID);
  });

  it('stays off when unconfigured, so no script is rendered', async () => {
    const m = await load({});
    expect(m.ANALYTICS_ENABLED).toBe(false);
    expect(m.ANALYTICS_ORIGIN).toBeNull();
    expect(process.env.NEXT_PUBLIC_UMAMI_SRC).toBeUndefined();
  });

  it('stays enabled with the origin derived, which the CSP then trusts', async () => {
    // The two must agree: an allowed-but-unrendered script, or a rendered
    // script with no CSP entry, both end in a silently empty dashboard.
    const m = await load({ src: SRC, id: ID });
    expect(m.ANALYTICS_ORIGIN).toBe(new URL(SRC).origin);
  });

  it('refuses a plain-http tracker, which would be mixed content', async () => {
    // This is the exact failure that shipped before: an http IP address that
    // `upgrade-insecure-requests` rewrites and script-src blocks.
    const m = await load({ src: 'http://109.123.244.167:3008/script.js', id: ID });
    expect(m.ANALYTICS_ORIGIN).toBeNull();
    expect(m.ANALYTICS_ENABLED).toBe(false);
  });

  it('disables analytics when the website id is missing', async () => {
    const m = await load({ src: SRC });
    expect(m.ANALYTICS_ENABLED).toBe(false);
  });

  it('disables analytics when the tracker url is malformed', async () => {
    const m = await load({ src: 'not a url', id: ID });
    expect(m.ANALYTICS_ORIGIN).toBeNull();
    expect(m.ANALYTICS_ENABLED).toBe(false);
  });

  it('trims surrounding whitespace from configured values', async () => {
    const m = await load({ src: `  ${SRC}  `, id: `  ${ID}  ` });
    expect(m.ANALYTICS_SCRIPT_SRC).toBe(SRC);
    expect(m.ANALYTICS_WEBSITE_ID).toBe(ID);
    expect(m.ANALYTICS_ENABLED).toBe(true);
  });
});