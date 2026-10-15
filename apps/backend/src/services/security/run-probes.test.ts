import { describe, it, expect, vi } from 'vitest';
// Orchestration semantics are independent of thread startup scheduling.
vi.mock('./isolated-probe', async () => {
  const { scanSast } = await import('./probes/sast');
  const { scanSecrets } = await import('./probes/secrets');
  return { runIsolatedProbe: async (type: string, diff: string) => type === 'sast' ? scanSast(diff) : scanSecrets(diff) };
});
import { runSecurityProbes } from './run-probes';
import type { SecurityConfig } from '../config.service';

const BASE: SecurityConfig = {
  enabled: true,
  sast: true,
  secrets: true,
  dependencies: true,
  osv: false,
  semgrep: true,
  block_on_critical_secret: true,
};

function config(overrides: Partial<SecurityConfig> = {}): SecurityConfig {
  return { ...BASE, ...overrides };
}

function diffFor(lines: string[], filename = 'src/app.js'): string {
  return [
    `diff --git a/${filename} b/${filename}`,
    `--- a/${filename}`,
    `+++ b/${filename}`,
    '@@ -1,1 +1,1 @@',
    ...lines.map((l) => `+${l}`),
  ].join('\n');
}

const SEMGREP_FINDING = JSON.stringify({
  results: [
    {
      check_id: 'javascript.lang.security.audit.sqli',
      path: 'src/app.js',
      start: { line: 1 },
      extra: { message: 'Possible SQL injection', metadata: { severity: 'HIGH' } },
    },
  ],
});

describe('runSecurityProbes — SAST coverage truthfulness', () => {
  it('marks SAST DEGRADED when the Semgrep binary is unavailable and the built-in rules are clean', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const outcome = await runSecurityProbes(config(), diffFor(['const x = 1;']), {
      semgrep: {
        files: new Map([['src/app.js', 'x']]),
        runner: async () => ({ stdout: '', stderr: '', exitCode: -1, missing: true }),
      },
    });

    const sast = outcome.checks.find((c) => c.probe === 'SAST')!;
    expect(sast.status).toBe('DEGRADED');
    expect(sast.detail).toContain('Semgrep');
    log.mockRestore();
  });

  it('keeps a built-in SAST finding as FAIL (with the degraded caveat) when Semgrep is unavailable', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const outcome = await runSecurityProbes(config(), diffFor(['db.query(`SELECT * FROM t WHERE id = ${id}`);']), {
      semgrep: {
        files: new Map([['src/app.js', 'x']]),
        runner: async () => ({ stdout: '', stderr: '', exitCode: -1, missing: true }),
      },
    });

    const sast = outcome.checks.find((c) => c.probe === 'SAST')!;
    expect(sast.status).toBe('FAIL');
    expect(sast.detail).toContain('Semgrep');
    // The built-in SQL-injection rule still produced a finding underneath.
    expect(outcome.findings.some((f) => f.source === 'SAST')).toBe(true);
    log.mockRestore();
  });

  it('keeps SAST PASS on a clean full-coverage run', async () => {
    const outcome = await runSecurityProbes(config(), diffFor(['const x = 1;']), {
      semgrep: {
        files: new Map([['src/app.js', 'const x = 1;']]),
        runner: async () => ({ stdout: '{"results":[]}', stderr: '', exitCode: 0 }),
      },
    });
    const sast = outcome.checks.find((c) => c.probe === 'SAST')!;
    expect(sast.status).toBe('PASS');
    expect(sast.detail).toBeUndefined();
  });

  it('folds Semgrep findings into the SAST check as FAIL', async () => {
    const outcome = await runSecurityProbes(config(), diffFor(['const x = 1;']), {
      semgrep: {
        files: new Map([['src/app.js', 'const x = 1;']]),
        runner: async () => ({ stdout: SEMGREP_FINDING, stderr: '', exitCode: 0 }),
      },
    });
    const sast = outcome.checks.find((c) => c.probe === 'SAST')!;
    expect(sast.status).toBe('FAIL');
    expect(sast.findingCount).toBe(1);
  });
});

describe('runSecurityProbes — orchestration', () => {
  it('returns an empty outcome when the security layer is disabled', async () => {
    const outcome = await runSecurityProbes(config({ enabled: false }), diffFor(['const x = 1;']));
    expect(outcome).toEqual({ findings: [], checks: [], enabledProbeCount: 0 });
  });

  it('counts DEGRADED probes as enabled but excludes SKIPPED ones', async () => {
    const outcome = await runSecurityProbes(
      config({ sast: false, secrets: false }),
      diffFor(['const x = 1;']),
    );
    // Only the dependency probe runs; with no manifests it is SKIPPED.
    expect(outcome.checks).toHaveLength(1);
    expect(outcome.checks[0].status).toBe('SKIPPED');
    expect(outcome.enabledProbeCount).toBe(0);
  });

  it('runs the dependency probe against the supplied lockfile diff', async () => {
    const outcome = await runSecurityProbes(config({ sast: false, secrets: false }), diffFor(['const x = 1;']), {
      dependencyDiff: [
        'diff --git a/package-lock.json b/package-lock.json',
        '--- a/package-lock.json',
        '+++ b/package-lock.json',
        '@@ -1,1 +1,1 @@',
        '   "packages": {',
        '+    "node_modules/lodash": {',
        '+      "version": "4.17.14",',
      ].join('\n'),
    });
    const deps = outcome.checks.find((c) => c.probe === 'DEPENDENCIES')!;
    expect(deps.status).toBe('FAIL');
    expect(deps.findingCount).toBeGreaterThan(0);
  });
});
