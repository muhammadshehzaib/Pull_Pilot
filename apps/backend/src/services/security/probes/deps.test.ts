import { describe, it, expect, vi } from 'vitest';
import { scanDependencies } from './deps';
import { OsvClient } from '../osv-client';

function npmDiff(added: string[], removed: string[] = []): string {
  const lines = [
    'diff --git a/package.json b/package.json',
    '--- a/package.json',
    '+++ b/package.json',
    '@@ -1,1 +1,1 @@',
    ' {',
    '   "name": "app",',
    '   "dependencies": {',
  ];
  for (const r of removed) lines.push(`-    ${r}`);
  for (const a of added) lines.push(`+    ${a}`);
  lines.push('   },', ' }');
  return lines.join('\n');
}

function pyDiff(added: string[]): string {
  return (
    'diff --git a/requirements.txt b/requirements.txt\n' +
    '--- a/requirements.txt\n' +
    '+++ b/requirements.txt\n' +
    '@@ -1,1 +1,1 @@\n' +
    added.map((a) => `+${a}`).join('\n')
  );
}

function goDiff(added: string[]): string {
  return (
    'diff --git a/go.mod b/go.mod\n' +
    '--- a/go.mod\n' +
    '+++ b/go.mod\n' +
    '@@ -1,1 +1,1 @@\n' +
    added.map((a) => `+${a}`).join('\n')
  );
}

function gemDiff(line: string): string {
  return (
    'diff --git a/Gemfile b/Gemfile\n' +
    '--- a/Gemfile\n' +
    '+++ b/Gemfile\n' +
    '@@ -1,1 +1,1 @@\n' +
    `+${line}`
  );
}

function npmLockDiff(packagePath: string, version: string): string {
  return [
    'diff --git a/package-lock.json b/package-lock.json',
    '--- a/package-lock.json',
    '+++ b/package-lock.json',
    '@@ -1,4 +1,6 @@',
    ' {',
    '   "packages": {',
    `+    "${packagePath}": {`,
    `+      "version": "${version}",`,
    '     }',
    '   }',
    ' }',
  ].join('\n');
}

/** A client backed by a fake transport; records the request bodies it saw. */
function osvClientReturning(
  vulnsByQuery: (query: { name: string; version: string; ecosystem: string }) => unknown[],
  seen: Array<{ name: string; version: string; ecosystem: string }> = [],
): OsvClient {
  const records = new Map<string, unknown>();
  return new OsvClient({
    detailTransport: async endpoint => records.get(endpoint.split('/').pop()!),
    transport: async (_endpoint, body) => {
      const results = body.queries.map((q) => {
        const ref = { name: q.package.name, version: q.version, ecosystem: q.package.ecosystem };
        seen.push(ref);
        const vulns = vulnsByQuery(ref) as any[];
        for (const vuln of vulns) records.set(vuln.id, vuln);
        return { vulns: vulns.map(vuln => ({ id: vuln.id })) };
      });
      return { results };
    },
  });
}

/** A client whose every request fails, exercising the offline fallback. */
function failingOsvClient(): OsvClient {
  return new OsvClient({
    transport: async () => {
      throw new Error('network down');
    },
  });
}

describe('dependencies probe — known-vulnerable ranges (offline registry)', () => {
  it('flags a vulnerable lodash range and anchors it on the dependency line', async () => {
    const findings = (await scanDependencies(npmDiff(['"lodash": "^4.17.14",']))).findings;
    const vuln = findings.find((f) => f.ruleKey === 'deps-vulnerable');
    expect(vuln).toBeDefined();
    expect(vuln!.priority).toBe('HIGH');
    expect(vuln!.issue).toContain('lodash');
    expect(vuln!.lineNumber).toBeGreaterThan(1);
  });

  it('does not flag a safe lodash range', async () => {
    const findings = (await scanDependencies(npmDiff(['"lodash": "^4.17.22",']))).findings;
    expect(findings.find((f) => f.ruleKey === 'deps-vulnerable')).toBeUndefined();
  });

  it('flags axios only within the affected major', async () => {
    expect((await scanDependencies(npmDiff(['"axios": "^0.19.0",']))).findings.some((f) => f.ruleKey === 'deps-vulnerable')).toBe(true);
    expect((await scanDependencies(npmDiff(['"axios": "^1.8.0",']))).findings.some((f) => f.ruleKey === 'deps-vulnerable')).toBe(false);
  });

  it('parses requirements.txt and go.mod manifests', async () => {
    expect((await scanDependencies(pyDiff(['Pillow>=8.0.0']))).findings.some((f) => f.ruleKey === 'deps-vulnerable')).toBe(true);
    expect((await scanDependencies(pyDiff(['Pillow==9.1.0']))).findings.some((f) => f.ruleKey === 'deps-vulnerable')).toBe(false);
  });

  it('parses Gemfile gems', async () => {
    const findings = (await scanDependencies(gemDiff("gem 'rake', '~> 13.0.1'"))).findings;
    // No advisory for rake; the proof of parsing is the INFO introduction note.
    expect(findings.some((f) => f.ruleKey === 'deps-introduced' && f.issue.includes('rake'))).toBe(true);
  });

  it('parses go.mod require statements', async () => {
    const findings = (await scanDependencies(goDiff(['require github.com/foo/bar v1.2.3']))).findings;
    expect(findings.some((f) => f.ruleKey === 'deps-introduced' && f.issue.includes('github.com/foo/bar'))).toBe(true);
  });
});

describe('dependencies probe — introduced and bumped dependencies', () => {
  it('notes newly introduced safe runtime dependencies as INFO', async () => {
    const findings = (await scanDependencies(npmDiff(['"commander": "^9.0.0",']))).findings;
    expect(findings.some((f) => f.ruleKey === 'deps-introduced' && f.priority === 'INFO')).toBe(true);
  });

  it('detects a major bump between the removed and added spec', async () => {
    const findings = (
      await scanDependencies(npmDiff(['"superagent": "^7.0.0",'], ['"superagent": "^6.1.0",']))
    ).findings;
    const bump = findings.find((f) => f.ruleKey === 'deps-major-bump');
    expect(bump).toBeDefined();
    expect(bump!.priority).toBe('LOW');
    expect(bump!.issue).toContain('superagent');
    expect(bump!.issue).toContain('6.1.0');
    expect(bump!.issue).toContain('7.0.0');
  });

  it('does not fire a major-bump note for a same-major update', async () => {
    const findings = (
      await scanDependencies(npmDiff(['"superagent": "^6.2.0",'], ['"superagent": "^6.1.0",']))
    ).findings;
    expect(findings.some((f) => f.ruleKey === 'deps-major-bump')).toBe(false);
  });
});

describe('dependencies probe — npm lockfiles', () => {
  it('checks newly resolved transitive packages against OSV', async () => {
    const seen: Array<{ name: string; version: string; ecosystem: string }> = [];
    const result = await scanDependencies('', {
      lockfileDiff: npmLockDiff('node_modules/transitive-vuln', '1.2.3'),
      osv: osvClientReturning(
        () => [{ id: 'GHSA-TEST-0001', summary: 'Test advisory', database_specific: { severity: 'HIGH' } }],
        seen,
      ),
    });

    expect(seen).toContainEqual({ name: 'transitive-vuln', version: '1.2.3', ecosystem: 'npm' });
    expect(result.findings).toEqual([
      expect.objectContaining({
        filePath: 'package-lock.json',
        lineNumber: 4,
        ruleKey: 'deps-vulnerable',
        priority: 'HIGH',
      }),
    ]);
  });

  it('extracts the innermost scoped package from nested npm lock paths', async () => {
    const seen: Array<{ name: string; version: string; ecosystem: string }> = [];
    await scanDependencies('', {
      lockfileDiff: npmLockDiff('node_modules/parent/node_modules/@scope/transitive', '2.3.4'),
      osv: osvClientReturning(() => [], seen),
    });
    expect(seen).toContainEqual({ name: '@scope/transitive', version: '2.3.4', ecosystem: 'npm' });
  });
});

describe('dependencies probe — OSV.dev integration', () => {
  it('queries the minimum selectable version in the right ecosystem', async () => {
    const seen: Array<{ name: string; version: string; ecosystem: string }> = [];
    const osv = osvClientReturning(() => [], seen);
    await scanDependencies(npmDiff(['"lodash": "^4.17.14",']), { osv });
    expect(seen).toEqual([{ name: 'lodash', version: '4.17.14', ecosystem: 'npm' }]);
  });

  it('reports an OSV vulnerability with its id, severity and remediation', async () => {
    const osv = osvClientReturning(() => [
      {
        id: 'GHSA-xxxx-yyyy-zzzz',
        summary: 'Prototype pollution in lodash',
        database_specific: { severity: 'CRITICAL' },
      },
    ]);
    const findings = (await scanDependencies(npmDiff(['"lodash": "^4.17.14",']), { osv })).findings;
    const vuln = findings.find((f) => f.ruleKey === 'deps-vulnerable');
    expect(vuln).toBeDefined();
    expect(vuln!.priority).toBe('CRITICAL');
    expect(vuln!.issue).toContain('GHSA-xxxx-yyyy-zzzz');
    expect(vuln!.suggestion).toContain('GHSA-xxxx-yyyy-zzzz');
    expect(vuln!.source).toBe('DEPENDENCIES');
  });

  it('treats a clean OSV answer as authoritative and does not use the stale offline list', async () => {
    // The bundled registry flags lodash < 4.17.21, but OSV says this resolution
    // is clean; the live database wins.
    const osv = osvClientReturning(() => []);
    const findings = (await scanDependencies(npmDiff(['"lodash": "^4.17.14",']), { osv })).findings;
    expect(findings.some((f) => f.ruleKey === 'deps-vulnerable')).toBe(false);
    expect(findings.some((f) => f.ruleKey === 'deps-introduced')).toBe(true);
  });

  it('falls back to the offline registry when OSV is unreachable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const osv = failingOsvClient();
    const findings = (await scanDependencies(npmDiff(['"lodash": "^4.17.14",']), { osv })).findings;
    expect(findings.some((f) => f.ruleKey === 'deps-vulnerable')).toBe(true);
    warn.mockRestore();
  });

  it('never queries OSV for a spec with no selectable version', async () => {
    const seen: Array<{ name: string; version: string; ecosystem: string }> = [];
    const osv = osvClientReturning(() => [], seen);
    await scanDependencies(npmDiff(['"commander": "latest",']), { osv });
    expect(seen).toHaveLength(0);
    // The package still gets its INFO introduction note.
  });
});

describe('dependencies probe — provenance', () => {
  it('stamps findings with source DEPENDENCIES and agentType SECURITY', async () => {
    const findings = (await scanDependencies(npmDiff(['"lodash": "^4.17.14",']))).findings;
    const f = findings.find((x) => x.ruleKey === 'deps-vulnerable')!;
    expect(f.source).toBe('DEPENDENCIES');
    expect(f.agentType).toBe('SECURITY');
  });
});

function lockfileDiff(filename: string, addedLines: string[], contextLines: string[] = []): string {
  const header = `diff --git a/${filename} b/${filename}`;
  return [
    header,
    `--- a/${filename}`,
    `+++ b/${filename}`,
    '@@ -1,1 +1,1 @@',
    ...contextLines.map((l) => ` ${l}`),
    ...addedLines.map((l) => `+${l}`),
  ].join('\n');
}

describe('dependencies probe — check status truthfulness', () => {
  it('reports SKIPPED when the diff has no manifests or lockfiles', async () => {
    const probe = await scanDependencies('');
    expect(probe.checks).toEqual([
      expect.objectContaining({ probe: 'DEPENDENCIES', status: 'SKIPPED', findingCount: 0 }),
    ]);
    expect(probe.checks[0].detail).toContain('No supported manifests');
  });

  it('reports SKIPPED when only removals touch a manifest', async () => {
    const probe = await scanDependencies(npmDiff([], ['"lodash": "^4.17.14",']));
    expect(probe.checks[0].status).toBe('SKIPPED');
  });

  it('reports PASS for a clean, fully-covered run', async () => {
    const osv = osvClientReturning(() => []);
    const probe = await scanDependencies(npmDiff(['"commander": "^9.0.0",']), { osv });
    expect(probe.checks[0].status).toBe('PASS');
  });

  it('reports DEGRADED (not PASS) when the live OSV lookup fails but nothing is flagged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const probe = await scanDependencies(npmDiff(['"commander": "^9.0.0",']), { osv: failingOsvClient() });
    expect(probe.checks[0].status).toBe('DEGRADED');
    expect(probe.checks[0].detail).toContain('OSV');
    warn.mockRestore();
  });

  it('keeps a finding as FAIL while still recording the degraded coverage in detail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const probe = await scanDependencies(npmDiff(['"lodash": "^4.17.14",']), { osv: failingOsvClient() });
    expect(probe.checks[0].status).toBe('FAIL');
    expect(probe.checks[0].detail).toContain('incomplete');
    warn.mockRestore();
  });
});

describe('dependencies probe — lockfile formats', () => {
  it('parses pnpm-lock.yaml single-line keys', async () => {
    const seen: Array<{ name: string; version: string; ecosystem: string }> = [];
    await scanDependencies('', {
      lockfileDiff: lockfileDiff('pnpm-lock.yaml', ['  transitive-vuln@1.2.3:'], ['packages:']),
      osv: osvClientReturning(() => [], seen),
    });
    expect(seen).toContainEqual({ name: 'transitive-vuln', version: '1.2.3', ecosystem: 'npm' });
  });

  it('parses scoped pnpm keys', async () => {
    const seen: Array<{ name: string; version: string; ecosystem: string }> = [];
    await scanDependencies('', {
      lockfileDiff: lockfileDiff('pnpm-lock.yaml', ["  '@scope/pkg@2.0.1':"], ['packages:']),
      osv: osvClientReturning(() => [], seen),
    });
    expect(seen).toContainEqual({ name: '@scope/pkg', version: '2.0.1', ecosystem: 'npm' });
  });

  it('parses yarn.lock v1 headers and version lines', async () => {
    const seen: Array<{ name: string; version: string; ecosystem: string }> = [];
    await scanDependencies('', {
      lockfileDiff: lockfileDiff('yarn.lock', ['lodash@^4.17.14:', '  version "4.17.20"']),
      osv: osvClientReturning(() => [], seen),
    });
    expect(seen).toContainEqual({ name: 'lodash', version: '4.17.20', ecosystem: 'npm' });
  });

  it('parses go.sum module pins without double-counting the go.mod hash', async () => {
    const seen: Array<{ name: string; version: string; ecosystem: string }> = [];
    await scanDependencies('', {
      lockfileDiff: lockfileDiff('go.sum', [
        'github.com/foo/bar v1.2.3 h1:AAAA=',
        'github.com/foo/bar v1.2.3/go.mod h1:BBBB=',
      ]),
      osv: osvClientReturning(() => [], seen),
    });
    expect(seen).toEqual([{ name: 'github.com/foo/bar', version: '1.2.3', ecosystem: 'Go' }]);
  });

  it('parses Gemfile.lock resolved specs', async () => {
    const seen: Array<{ name: string; version: string; ecosystem: string }> = [];
    await scanDependencies('', {
      lockfileDiff: lockfileDiff('Gemfile.lock', ['    rake (13.0.1)']),
      osv: osvClientReturning(() => [], seen),
    });
    expect(seen).toContainEqual({ name: 'rake', version: '13.0.1', ecosystem: 'RubyGems' });
  });

  it('parses Cargo.lock name/version blocks', async () => {
    const seen: Array<{ name: string; version: string; ecosystem: string }> = [];
    await scanDependencies('', {
      lockfileDiff: lockfileDiff('Cargo.lock', ['version = "1.0.6"'], ['name = "serde"']),
      osv: osvClientReturning(() => [], seen),
    });
    expect(seen).toContainEqual({ name: 'serde', version: '1.0.6', ecosystem: 'crates.io' });
  });

  it('parses poetry.lock name/version pairs', async () => {
    const seen: Array<{ name: string; version: string; ecosystem: string }> = [];
    await scanDependencies('', {
      lockfileDiff: lockfileDiff('poetry.lock', ['version = "2.25.0"'], ['name = "requests"']),
      osv: osvClientReturning(() => [], seen),
    });
    expect(seen).toContainEqual({ name: 'requests', version: '2.25.0', ecosystem: 'PyPI' });
  });
});

describe('dependencies probe — deduplication', () => {
  it('does not double-count the same advisory from a manifest and its lockfile', async () => {
    const osv = osvClientReturning(() => [
      { id: 'GHSA-DEDUPE-0001', summary: 'Duplicate advisory', database_specific: { severity: 'HIGH' } },
    ]);
    const probe = await scanDependencies(npmDiff(['"lodash": "^4.17.14",']), {
      osv,
      lockfileDiff: lockfileDiff('package-lock.json', [
        '"packages": {',
        '  "node_modules/lodash": {',
        '    "version": "4.17.14",',
      ]),
    });
    const vulns = probe.findings.filter((f) => f.ruleKey === 'deps-vulnerable');
    expect(vulns).toHaveLength(1);
    expect(vulns[0].filePath).toBe('package.json');
  });
});
