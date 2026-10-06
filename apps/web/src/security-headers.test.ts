import { describe, it, expect, afterEach, vi } from 'vitest';
import type { NextConfig } from 'next';

/**
 * Guards the response security headers that used to be entirely absent, which
 * is what an external site scan reported as "0 security headers".
 */

const ENV_KEYS = [
  'NODE_ENV',
  'NEXT_PUBLIC_BACKEND_URL',
  'NEXT_PUBLIC_UMAMI_SRC',
  'NEXT_PUBLIC_UMAMI_WEBSITE_ID',
] as const;
const savedEnv = new Map<string, string | undefined>();

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

async function loadHeaders(env: Record<string, string> = {}) {
  for (const key of ENV_KEYS) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  }
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }

  // The config reads env at module scope, so it must be re-evaluated.
  vi.resetModules();
  const { default: config } = await import('../next.config');
  const resolveHeaders = config.headers;
  if (typeof resolveHeaders !== 'function') {
    throw new Error('next.config must export a headers() function');
  }
  const rules = await resolveHeaders();

  const headers = new Map<string, string>();
  const sources: string[] = [];
  for (const rule of rules) {
    sources.push(rule.source);
    for (const header of rule.headers) {
      headers.set(header.key.toLowerCase(), header.value);
    }
  }
  return { headers, sources };
}

describe('security headers', () => {
  it('applies to every route', async () => {
    const { sources } = await loadHeaders();
    expect(sources).toContain('/:path*');
  });

  it('sets the core headers an external scan checks for', async () => {
    const { headers } = await loadHeaders();

    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('x-frame-options')).toBe('DENY');
    expect(headers.get('referrer-policy')).toBe(
      'strict-origin-when-cross-origin',
    );
    expect(headers.get('permissions-policy')).toContain('camera=()');
    expect(headers.get('content-security-policy')).toBeTruthy();
  });

  it('does not advertise the framework', async () => {
    vi.resetModules();
    const { default: config } = await import('../next.config');
    expect(config.poweredByHeader).toBe(false);
  });

  it('locks down the CSP and keeps next/font self-hosted', async () => {
    const { headers } = await loadHeaders();
    const csp = headers.get('content-security-policy') ?? '';

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("font-src 'self'");
  });

  it('allows the API origin and its websocket for live dashboard updates', async () => {
    const { headers } = await loadHeaders({
      NEXT_PUBLIC_BACKEND_URL: 'https://api.example.com',
    });
    const csp = headers.get('content-security-policy') ?? '';

    expect(csp).toContain('connect-src');
    expect(csp).toContain('https://api.example.com');
    // socket.io opens a WebSocket to the same host.
    expect(csp).toContain('wss://api.example.com');
  });

  it('maps a local http backend to ws, not wss', async () => {
    const { headers } = await loadHeaders({
      NEXT_PUBLIC_BACKEND_URL: 'http://localhost:4000',
    });
    const csp = headers.get('content-security-policy') ?? '';

    expect(csp).toContain('ws://localhost:4000');
    expect(csp).not.toContain('wss://localhost:4000');
  });

  it('omits HSTS and upgrade-insecure-requests outside production', async () => {
    const { headers } = await loadHeaders({ NODE_ENV: 'development' });

    expect(headers.has('strict-transport-security')).toBe(false);
    expect(headers.get('content-security-policy')).not.toContain(
      'upgrade-insecure-requests',
    );
  });

  it('enables HSTS and upgrades insecure requests in production', async () => {
    const { headers } = await loadHeaders({ NODE_ENV: 'production' });

    expect(headers.get('strict-transport-security')).toContain('max-age=');
    expect(headers.get('content-security-policy')).toContain(
      'upgrade-insecure-requests',
    );
  });

  it('never ships unsafe-eval to production', async () => {
    const { headers } = await loadHeaders({ NODE_ENV: 'production' });
    expect(headers.get('content-security-policy')).not.toContain('unsafe-eval');
  });

  it('allows no third-party script origin when analytics is unconfigured', async () => {
    const { headers } = await loadHeaders({ NODE_ENV: 'production' });
    const scriptSrc = (headers.get('content-security-policy') ?? '')
      .split(';')
      .find((part) => part.trim().startsWith('script-src'));

    expect(scriptSrc).toBeDefined();
    // The whole point of dropping the hardcoded tracker: with nothing
    // configured, script-src grants no external origin at all.
    expect(scriptSrc).not.toContain('https://');
  });

  it('allows the configured analytics origin for both the script and its beacons', async () => {
    const { headers } = await loadHeaders({
      NODE_ENV: 'production',
      NEXT_PUBLIC_UMAMI_SRC: 'https://analytics.example.com/script.js',
      NEXT_PUBLIC_UMAMI_WEBSITE_ID: 'site-1',
    });
    const csp = headers.get('content-security-policy') ?? '';

    const scriptSrc = csp.split(';').find((part) => part.trim().startsWith('script-src'));
    const connectSrc = csp.split(';').find((part) => part.trim().startsWith('connect-src'));

    // Loading it but not allowing connect-src means a script that loads and
    // then sends nothing, which is how the previous setup failed silently.
    expect(scriptSrc).toContain('https://analytics.example.com');
    expect(connectSrc).toContain('https://analytics.example.com');
  });

  it('refuses to allow a plain-http analytics origin', async () => {
    const { headers } = await loadHeaders({
      NODE_ENV: 'production',
      NEXT_PUBLIC_UMAMI_SRC: 'http://109.123.244.167:3008/script.js',
      NEXT_PUBLIC_UMAMI_WEBSITE_ID: 'site-1',
    });
    const csp = headers.get('content-security-policy') ?? '';

    expect(csp).not.toContain('109.123.244.167');
  });
});