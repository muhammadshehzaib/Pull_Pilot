import { describe, it, expect, vi } from 'vitest';
import { OsvClient, osvSeverity, type OsvBatchRequest } from './osv-client';

function clientCapturing(captured: OsvBatchRequest[]): OsvClient {
  return new OsvClient({
    transport: async (_endpoint, body) => {
      captured.push(body);
      return {
        results: body.queries.map((q) => ({
          vulns: [{ id: `OSV-${q.package.name}`, summary: `issue in ${q.package.name}` }],
        })),
      };
    },
  });
}

describe('OsvClient.query', () => {
  it('sends one batched request and aligns results to refs', async () => {
    const captured: OsvBatchRequest[] = [];
    const osv = clientCapturing(captured);

    const outcome = await osv.query([
      { name: 'lodash', version: '4.17.14', ecosystem: 'npm' },
      { name: 'Pillow', version: '8.0.0', ecosystem: 'PyPI' },
    ]);

    expect(captured).toHaveLength(1);
    expect(captured[0].queries).toEqual([
      { package: { name: 'lodash', ecosystem: 'npm' }, version: '4.17.14' },
      { package: { name: 'Pillow', ecosystem: 'PyPI' }, version: '8.0.0' },
    ]);
    expect(outcome.degraded).toBe(false);
    expect(outcome.results.map((r) => r.vulnerabilities[0].id)).toEqual(['OSV-lodash', 'OSV-Pillow']);
  });

  it('dedupes identical package+version+ecosystem tuples', async () => {
    const captured: OsvBatchRequest[] = [];
    const osv = clientCapturing(captured);

    await osv.query([
      { name: 'lodash', version: '4.17.14', ecosystem: 'npm' },
      { name: 'lodash', version: '4.17.14', ecosystem: 'npm' },
      { name: 'Lodash', version: '4.17.14', ecosystem: 'npm' },
    ]);

    expect(captured[0].queries).toHaveLength(1);
  });

  it('does nothing and reports healthy when there are no refs', async () => {
    const transport = vi.fn();
    const osv = new OsvClient({ transport });
    const outcome = await osv.query([]);
    expect(transport).not.toHaveBeenCalled();
    expect(outcome).toEqual({ results: [], degraded: false });
  });

  it('splits large inputs into batches', async () => {
    const captured: OsvBatchRequest[] = [];
    const osv = new OsvClient({
      maxBatch: 2,
      transport: async (_endpoint, body) => {
        captured.push(body);
        return { results: body.queries.map(() => ({ vulns: [] })) };
      },
    });

    await osv.query(
      Array.from({ length: 5 }, (_, i) => ({ name: `pkg${i}`, version: '1.0.0', ecosystem: 'npm' })),
    );

    expect(captured.map((b) => b.queries.length)).toEqual([2, 2, 1]);
  });

  it('reports degraded instead of throwing when the transport fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const osv = new OsvClient({
      transport: async () => {
        throw new Error('boom');
      },
    });

    const outcome = await osv.query([{ name: 'lodash', version: '4.17.14', ecosystem: 'npm' }]);
    expect(outcome.degraded).toBe(true);
    expect(outcome.results).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('drops records without an id', async () => {
    const osv = new OsvClient({
      transport: async (_endpoint, body) => ({
        results: body.queries.map(() => ({ vulns: [{ summary: 'no id here' }] })),
      }),
    });
    const outcome = await osv.query([{ name: 'x', version: '1.0.0', ecosystem: 'npm' }]);
    expect(outcome.results[0].vulnerabilities).toHaveLength(0);
  });

  it('defaults the summary from details when summary is missing', async () => {
    const osv = new OsvClient({
      transport: async (_endpoint, body) => ({
        results: body.queries.map(() => ({
          vulns: [{ id: 'OSV-1', details: 'First line.\nSecond line.' }],
        })),
      }),
    });
    const outcome = await osv.query([{ name: 'x', version: '1.0.0', ecosystem: 'npm' }]);
    expect(outcome.results[0].vulnerabilities[0].summary).toBe('First line.');
  });
});

describe('osvSeverity', () => {
  it('prefers database_specific severity and normalises aliases', () => {
    expect(osvSeverity({ database_specific: { severity: 'MODERATE' } })).toBe('MEDIUM');
    expect(osvSeverity({ database_specific: { severity: 'high' } })).toBe('HIGH');
  });

  it('falls back to ecosystem_specific severity', () => {
    expect(osvSeverity({ ecosystem_specific: { severity: 'CRITICAL' } })).toBe('CRITICAL');
  });

  it('maps a numeric CVSS score', () => {
    expect(osvSeverity({ database_specific: { cvss_score: 9.8 } })).toBe('CRITICAL');
    expect(osvSeverity({ database_specific: { cvss_score: '7.5' } })).toBe('HIGH');
    expect(osvSeverity({ database_specific: { cvss_score: 5 } })).toBe('MEDIUM');
    expect(osvSeverity({ database_specific: { cvss_score: 2 } })).toBe('LOW');
  });

  it('falls back to a numeric score in the severity vector list', async () => {
    expect(osvSeverity({ severity: [{ type: 'CVSS_V3', score: '8.1' }] })).toBe('HIGH');
  });

  it('defaults to MEDIUM when nothing usable is present', () => {
    expect(osvSeverity({ severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N' }] })).toBe('MEDIUM');
    expect(osvSeverity({})).toBe('MEDIUM');
  });
});