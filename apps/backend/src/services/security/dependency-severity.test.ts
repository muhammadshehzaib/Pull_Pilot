import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OsvClient } from './osv-client';
import { scanDependencies } from './probes/deps';
import { assessRisk, assessExplainableRisk } from './risk-engine';

const manifest = (name = 'vm2', version = '3.9.17') => [
  'diff --git a/package.json b/package.json', '--- a/package.json', '+++ b/package.json',
  '@@ -0,0 +1,3 @@', '+"dependencies": {', `+  "${name}": "${version}"`, '+}',
].join('\n');
const lockfile = (name = 'vm2', version = '3.9.17') => [
  'diff --git a/package-lock.json b/package-lock.json', '--- a/package-lock.json', '+++ b/package-lock.json',
  '@@ -0,0 +1,6 @@', '+{', '+"packages": {', `+"node_modules/${name}": {`, `+"version": "${version}"`, '+}', '+}', '+}',
].join('\n');
const id = 'GHSA-248r-7h7q-cr24';
const criticalVector = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
const bulk = async () => ({ results: [{ vulns: [{ id, modified: '2026-10-17T00:00:00Z' }] }] });
beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe('dependency severity from ID-only OSV through both risk engines', () => {
  it.each([
    { database_specific: { severity: 'CRITICAL' } },
    { database_specific: { cvss_score: 9.8 } },
    { severity: [{ type: 'CVSS_V3', score: criticalVector }] },
    { severity: [{ type: 'CVSS_V4', score: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H' }] },
    { database_specific: { severity: 'LOW' }, severity: [{ type: 'CVSS_V3', score: '5.1' }, { type: 'CVSS_V3', score: criticalVector }] },
    { affected: [{ package: { name: 'vm2', ecosystem: 'npm' }, ecosystem_specific: { severity: 'CRITICAL' } }] },
  ])('preserves critical evidence %j and forces advisory BLOCK', async evidence => {
    const detailTransport = vi.fn(async () => ({ id, summary: 'Sandbox escape', ...evidence }));
    const probe = await scanDependencies(manifest(), { osv: new OsvClient({ transport: bulk, detailTransport }) });
    expect(detailTransport).toHaveBeenCalledOnce(); expect(probe.checks[0]).toMatchObject({ status: 'FAIL', findingCount: 1 });
    expect(probe.findings).toEqual([expect.objectContaining({ source: 'DEPENDENCIES', priority: 'CRITICAL', filePath: 'package.json', ruleKey: 'deps-vulnerable' })]);
    expect(probe.findings[0]!.issue).toContain(id);
    expect(assessRisk(probe.findings).report).toMatchObject({ verdict: 'BLOCK', blockingCount: 1 });
    expect(assessExplainableRisk(probe.findings, { securityChecks: probe.checks })).toMatchObject({ verdict: 'BLOCK', blockingCount: 1, enforcement: 'ADVISORY' });
  });
  it('preserves critical severity for transitive lockfile dependencies', async () => {
    const probe = await scanDependencies('', { lockfileDiff: lockfile(), osv: new OsvClient({ transport: bulk,
      detailTransport: async () => ({ id, severity: [{ type: 'CVSS_V3', score: criticalVector }] }) }) });
    expect(probe.findings[0]).toMatchObject({ filePath: 'package-lock.json', priority: 'CRITICAL', ruleKey: 'deps-vulnerable' });
    expect(assessRisk(probe.findings).report.verdict).toBe('BLOCK');
    expect(assessExplainableRisk(probe.findings).verdict).toBe('BLOCK');
  });
  it.each(['missing severity', 'missing detail', 'failed detail'])('requires manual REVIEW for %s without inventing critical severity', async failure => {
    const probe = await scanDependencies(manifest(), { osv: new OsvClient({ transport: bulk, detailTransport: async () => {
      if (failure === 'failed detail') throw new Error('unavailable');
      return failure === 'missing detail' ? null : { id, summary: 'Known vulnerability' };
    } }) });
    expect(probe.findings[0]).toMatchObject({ priority: 'HIGH', source: 'DEPENDENCIES' });
    expect(probe.findings[0]!.issue).toContain('Severity is unconfirmed');
    expect(probe.checks[0]).toMatchObject({ status: 'FAIL', detail: expect.stringContaining('incomplete') });
    expect(assessRisk(probe.findings).report.verdict).toBe('REVIEW');
    const v2 = assessExplainableRisk(probe.findings, { securityChecks: probe.checks });
    expect(v2.verdict).toBe('REVIEW'); expect(v2.coverage.security.DEPENDENCIES).toBe('PARTIAL');
  });
  it.each(['manifest', 'lockfile'])('keeps critical offline evidence alongside incomplete live %s data', async source => {
    const osv = new OsvClient({ transport: bulk, detailTransport: async () => null });
    const probe = await scanDependencies(source === 'manifest' ? manifest('path-to-regexp', '8.1.0') : '',
      { osv, ...(source === 'lockfile' ? { lockfileDiff: lockfile('path-to-regexp', '8.1.0') } : {}) });
    expect(probe.findings.map(f => f.priority)).toEqual(['CRITICAL', 'HIGH']);
    expect(probe.checks[0]?.detail).toContain('incomplete');
    expect(assessRisk(probe.findings).report.verdict).toBe('BLOCK');
    expect(assessExplainableRisk(probe.findings).verdict).toBe('BLOCK');
  });
  it('retains a confirmed critical finding when another advisory detail fails', async () => {
    const osv = new OsvClient({ transport: async () => ({ results: [{ vulns: [{ id: 'OSV-missing' }, { id }] }] }),
      detailTransport: async endpoint => endpoint.endsWith(id) ? { id, database_specific: { severity: 'CRITICAL' } } : null });
    const probe = await scanDependencies(manifest(), { osv });
    expect(probe.findings.map(f => f.priority)).toEqual(['CRITICAL', 'HIGH']);
    expect(probe.checks[0]?.detail).toContain('incomplete');
    expect(assessRisk(probe.findings).report.verdict).toBe('BLOCK');
  });
  it('keeps a genuinely clean complete result authoritative over the offline registry', async () => {
    const probe = await scanDependencies(manifest('path-to-regexp', '8.1.0'), { osv: new OsvClient({ transport: async () => ({ results: [{}] }) }) });
    expect(probe.findings.filter(f => f.ruleKey === 'deps-vulnerable')).toEqual([]);
    expect(probe.checks[0]).toMatchObject({ status: 'PASS', findingCount: 0 });
  });
});
