import { describe, it, expect } from 'vitest';
import { scanDependencies } from './deps';

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

describe('dependencies probe — known-vulnerable ranges', () => {
  it('flags a vulnerable lodash range and anchors it on the dependency line', () => {
    const findings = scanDependencies(npmDiff(['"lodash": "^4.17.14",'])).findings;
    const vuln = findings.find((f) => f.ruleKey === 'deps-vulnerable');
    expect(vuln).toBeDefined();
    expect(vuln!.priority).toBe('HIGH');
    expect(vuln!.issue).toContain('lodash');
    expect(vuln!.lineNumber).toBeGreaterThan(1);
  });

  it('does not flag a safe lodash range', () => {
    const findings = scanDependencies(npmDiff(['"lodash": "^4.17.22",'])).findings;
    expect(findings.find((f) => f.ruleKey === 'deps-vulnerable')).toBeUndefined();
  });

  it('flags axios only within the affected major', () => {
    expect(scanDependencies(npmDiff(['"axios": "^0.19.0",'])).findings.some((f) => f.ruleKey === 'deps-vulnerable')).toBe(true);
    expect(scanDependencies(npmDiff(['"axios": "^1.8.0",'])).findings.some((f) => f.ruleKey === 'deps-vulnerable')).toBe(false);
  });

  it('parses requirements.txt and go.mod manifests', () => {
    expect(scanDependencies(pyDiff(['Pillow>=8.0.0'])).findings.some((f) => f.ruleKey === 'deps-vulnerable')).toBe(true);
    expect(scanDependencies(pyDiff(['Pillow==9.1.0'])).findings.some((f) => f.ruleKey === 'deps-vulnerable')).toBe(false);
  });

  it('parses Gemfile gems', () => {
    const findings = scanDependencies(gemDiff("gem 'rake', '~> 13.0.1'")).findings;
    // No advisory for rake; the proof of parsing is the INFO introduction note.
    expect(findings.some((f) => f.ruleKey === 'deps-introduced' && f.issue.includes('rake'))).toBe(true);
  });

  it('parses go.mod require statements', () => {
    const findings = scanDependencies(goDiff(['require github.com/foo/bar v1.2.3'])).findings;
    expect(findings.some((f) => f.ruleKey === 'deps-introduced' && f.issue.includes('github.com/foo/bar'))).toBe(true);
  });
});

describe('dependencies probe — introduced and bumped dependencies', () => {
  it('notes newly introduced safe runtime dependencies as INFO', () => {
    const findings = scanDependencies(npmDiff(['"commander": "^9.0.0",'])).findings;
    expect(findings.some((f) => f.ruleKey === 'deps-introduced' && f.priority === 'INFO')).toBe(true);
  });

  it('detects a major bump between the removed and added spec', () => {
    const findings = scanDependencies(
      npmDiff(['"superagent": "^7.0.0",'], ['"superagent": "^6.1.0",']),
    ).findings;
    const bump = findings.find((f) => f.ruleKey === 'deps-major-bump');
    expect(bump).toBeDefined();
    expect(bump!.priority).toBe('LOW');
    expect(bump!.issue).toContain('superagent');
    expect(bump!.issue).toContain('6.1.0');
    expect(bump!.issue).toContain('7.0.0');
  });

  it('does not fire a major-bump note for a same-major update', () => {
    const findings = scanDependencies(
      npmDiff(['"superagent": "^6.2.0",'], ['"superagent": "^6.1.0",']),
    ).findings;
    expect(findings.some((f) => f.ruleKey === 'deps-major-bump')).toBe(false);
  });
});

describe('dependencies probe — provenance', () => {
  it('stamps findings with source DEPENDENCIES and agentType SECURITY', () => {
    const f = scanDependencies(npmDiff(['"lodash": "^4.17.14",'])).findings[0];
    expect(f.source).toBe('DEPENDENCIES');
    expect(f.agentType).toBe('SECURITY');
  });
});