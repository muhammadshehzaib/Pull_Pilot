import { describe, expect, it } from 'vitest';
import { osvSeverity } from './osv-severity';

const critical3 = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
const critical4 = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H';
describe('OSV severity from full advisory evidence', () => {
  it.each([
    ['CVSS_V2', 'AV:N/AC:L/Au:N/C:C/I:C/A:C', 'CRITICAL'],
    ['CVSS_V2', 'CVSS:2.0/AV:N/AC:L/Au:N/C:C/I:C/A:C', 'CRITICAL'],
    ['CVSS_V2', 'AV:N/AC:L/Au:N/C:N/I:N/A:C', 'HIGH'],
    ['CVSS_V2', 'AV:L/AC:H/Au:N/C:C/I:C/A:C', 'MEDIUM'],
    ['CVSS_V2', 'AV:N/AC:L/Au:N/C:N/I:N/A:N', 'INFO'],
    ['CVSS_V3', critical3, 'CRITICAL'],
    ['CVSS_V3', critical3.replace('3.1', '3.0'), 'CRITICAL'],
    ['CVSS_V3', 'CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:L/I:L/A:N', 'LOW'],
    ['CVSS_V4', critical4, 'CRITICAL'],
    ['CVSS_V4', critical4 + '/E:U', 'CRITICAL'],
    ['CVSS_V4', critical4.replace(/:[H]/g, ':N'), 'INFO'],
  ])('calculates %s %s as %s using base metrics', (type, score, expected) => {
    expect(osvSeverity({ severity: [{ type, score }] })).toBe(expected);
  });
  it('preserves the highest valid severity across labels and score entries', () => {
    expect(osvSeverity({ database_specific: { severity: 'LOW', cvss_score: 7.2 },
      severity: [{ type: 'CVSS_V3', score: '4.1' }, { type: 'CVSS_V3', score: critical3 }] })).toBe('CRITICAL');
    expect(osvSeverity({ severity: [{ type: 'CVSS_V3', score: '4.1' }, { type: 'CVSS_V3', score: '9.8' }] })).toBe('CRITICAL');
  });
  it.each([[-1, null], [11, null], [NaN, null], [Infinity, null], ['', null], [' ', null], ['1e1', null],
    [0, 'INFO'], [0.1, 'LOW'], [3.9, 'LOW'], [4, 'MEDIUM'], [6.9, 'MEDIUM'], [7, 'HIGH'], [8.9, 'HIGH'], [9, 'CRITICAL'], [10, 'CRITICAL']])(
    'validates and maps numeric score %s', (cvss_score, expected) => expect(osvSeverity({ database_specific: { cvss_score } })).toBe(expected),
  );
  it.each([
    { severity: [{ type: 'CVSS_V3', score: critical3 + '/AV:L' }] },
    { severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N' }] },
    { severity: [{ type: 'CVSS_V3', score: critical4 }] },
    { severity: [{ type: 'EPSS', score: '9.9' }] },
    { severity: [{ type: 'CVSS_V2', score: 'AV:N/AC:L/Au:N/C:C/I:C/A:C/A:C' }] },
    { severity: [{ type: 'CVSS_V2', score: 'AV:N/AC:L/Au:N/C:C/I:C/A:C/UNKNOWN:X' }] },
    { severity: [{ type: 'CVSS_V4', score: 'CVSS:4.0/' + 'AV:N/'.repeat(300) }] },
    { severity: [null, 'invalid'] }, null, {},
  ])('does not invent severity from malformed/unsupported evidence %j', raw => expect(osvSeverity(raw)).toBeNull());
  it('uses affected severity only for the requested package/ecosystem', () => {
    const raw = { affected: [
      { package: { name: 'a', ecosystem: 'npm' }, ecosystem_specific: { severity: 'MEDIUM' } },
      { package: { name: 'a', ecosystem: 'PyPI' }, ecosystem_specific: { severity: 'CRITICAL' } },
    ] };
    expect(osvSeverity(raw, { name: 'a', version: '1.0.0', ecosystem: 'npm' })).toBe('MEDIUM');
    expect(osvSeverity(raw, { name: 'a', version: '1.0.0', ecosystem: 'PyPI' })).toBe('CRITICAL');
    expect(osvSeverity(raw, { name: 'b', version: '1.0.0', ecosystem: 'npm' })).toBeNull();
  });
  it('marks excessive evidence unknown unless a critical rating was already confirmed', () => {
    const severity = Array.from({ length: 17 }, () => ({ type: 'CVSS_V3', score: '4.1' }));
    expect(osvSeverity({ severity })).toBeNull();
    expect(osvSeverity({ severity, database_specific: { severity: 'CRITICAL' } })).toBe('CRITICAL');
  });
});
