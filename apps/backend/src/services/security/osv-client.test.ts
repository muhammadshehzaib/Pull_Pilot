import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OsvClient, osvSeverity, OSV_LIMITS, type OsvBatchRequest, type OsvBatchResponse } from './osv-client';

beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function clientCapturing(captured: OsvBatchRequest[]): OsvClient {
  return new OsvClient({
    detailTransport: async endpoint => ({ id: endpoint.split('/').pop(), summary: 'Test advisory', database_specific: { severity: 'MEDIUM' } }),
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
    expect(outcome.results).toMatchObject([{ complete: false, vulnerabilities: [] }]);
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
      detailTransport: async () => ({ id: 'OSV-1', details: 'First line.\nSecond line.', database_specific: { severity: 'MEDIUM' } }),
      transport: async (_endpoint, body) => ({
        results: body.queries.map(() => ({
          vulns: [{ id: 'OSV-1' }],
        })),
      }),
    });
    const outcome = await osv.query([{ name: 'x', version: '1.0.0', ecosystem: 'npm' }]);
    expect(outcome.results[0].vulnerabilities[0].summary).toBe('First line.');
  });
});

const ref = (name = 'sample') => ({ name, version: '1.0.0', ecosystem: 'npm' });
const bulk = (...ids: string[]): OsvBatchResponse => ({ results: [{ vulns: ids.map(id => ({ id, modified: '2026-10-17T00:00:00Z' })) }] });
const full = (id: string) => ({ id, summary: 'Known critical issue', database_specific: { severity: 'CRITICAL' } });

describe('OSV full advisory retrieval and coverage', () => {
  it('does not mix case-sensitive advisory IDs in the severity cache', async () => {
    const result = await new OsvClient({ transport: async () => bulk('OSV-case', 'OSV-CASE'),
      detailTransport: async endpoint => ({ id: endpoint.split('/').pop(), database_specific: { severity: endpoint.endsWith('OSV-CASE') ? 'CRITICAL' : 'MEDIUM' } }),
    }).query([ref()]);
    expect(result.results[0]!.vulnerabilities.map(v => v.severity)).toEqual(['MEDIUM', 'CRITICAL']);
  });
  it('hydrates ID-only responses once per advisory across packages and versions', async () => {
    const detailTransport = vi.fn(async (_endpoint: string) => full('GHSA-example'));
    const client = new OsvClient({ transport: async (_endpoint, body) => ({ results: body.queries.map(() => bulk('GHSA-example').results![0]!) }), detailTransport });
    const result = await client.query([ref('a'), ref('b')]);
    expect(detailTransport).toHaveBeenCalledOnce();
    expect(detailTransport.mock.calls[0]![0]).toBe('https://api.osv.dev/v1/vulns/GHSA-example');
    expect(result.degraded).toBe(false);
    expect(result.results.map(r => r.vulnerabilities[0])).toEqual([0, 1].map(() => expect.objectContaining({ severity: 'CRITICAL', severityKnown: true })));
    await client.query([ref('a')]);
    expect(detailTransport).toHaveBeenCalledTimes(2);
  });
  it('computes package-specific severity while sharing the same detail GET', async () => {
    const detailTransport = vi.fn(async () => ({ id: 'OSV-shared', affected: [
      { package: { name: 'a', ecosystem: 'npm' }, ecosystem_specific: { severity: 'MEDIUM' } },
      { package: { name: 'b', ecosystem: 'npm' }, ecosystem_specific: { severity: 'CRITICAL' } },
    ] }));
    const client = new OsvClient({ transport: async () => ({ results: [bulk('OSV-shared').results![0]!, bulk('OSV-shared').results![0]!] }), detailTransport });
    expect((await client.query([ref('a'), ref('b')])).results.map(r => r.vulnerabilities[0]!.severity)).toEqual(['MEDIUM', 'CRITICAL']);
    expect(detailTransport).toHaveBeenCalledOnce();
  });
  it.each([null, {}, { id: 'wrong-id' }, { id: 'OSV-1', summary: 'No severity' }])('retains the ID and requires manual review for bad detail %j', async detail => {
    const result = await new OsvClient({ transport: async () => bulk('OSV-1'), detailTransport: async () => detail }).query([ref()]);
    expect(result.degraded).toBe(true);
    expect(result.results[0]).toMatchObject({ complete: false, vulnerabilities: [{ id: 'OSV-1', severity: 'HIGH', severityKnown: false }] });
  });
  it('omits a confirmed withdrawn advisory without inventing a finding', async () => {
    const result = await new OsvClient({ transport: async () => bulk('OSV-1'), detailTransport: async () => ({ id: 'OSV-1', withdrawn: '2026-10-01T00:00:00Z' }) }).query([ref()]);
    expect(result).toMatchObject({ degraded: false, results: [{ complete: true, vulnerabilities: [] }] });
  });
  it('retains valid package alignment and does not treat a missing batch result as clean', async () => {
    const result = await new OsvClient({ transport: async () => bulk('OSV-1'), detailTransport: async () => full('OSV-1') }).query([ref('a'), ref('b')]);
    expect(result.degraded).toBe(true);
    expect(result.results[0]).toMatchObject({ ref: ref('a'), complete: true, vulnerabilities: [{ severity: 'CRITICAL' }] });
    expect(result.results[1]).toMatchObject({ ref: ref('b'), complete: false, vulnerabilities: [] });
  });
  it.each([{}, null, { results: 'bad' }, { results: [{ vulns: 'bad' }] }])('rejects invalid batch shape %j without claiming clean coverage', async response => {
    const result = await new OsvClient({ transport: async () => response as any }).query([ref()]);
    expect(result).toMatchObject({ degraded: true, results: [{ complete: false }] });
  });
  it('paginates only packages with a continuation token and preserves all IDs', async () => {
    const transport = vi.fn(async (_endpoint, body: OsvBatchRequest) => body.queries.length === 2
      ? { results: [{ vulns: [{ id: 'OSV-1' }], next_page_token: 'more' }, {}] }
      : bulk('OSV-2'));
    const result = await new OsvClient({ transport, detailTransport: async endpoint => full(endpoint.split('/').pop()!) }).query([ref('a'), ref('b')]);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1]![1].queries).toEqual([{ package: { name: 'a', ecosystem: 'npm' }, version: '1.0.0', page_token: 'more' }]);
    expect(result.degraded).toBe(false); expect(result.results[0]!.vulnerabilities.map(v => v.id)).toEqual(['OSV-1', 'OSV-2']);
  });
  it('bounds repeated pagination tokens', async () => {
    const transport = vi.fn(async () => ({ results: [{ vulns: [{ id: 'OSV-1' }], next_page_token: 'same' }] }));
    const result = await new OsvClient({ transport, detailTransport: async () => full('OSV-1') }).query([ref()]);
    expect(transport).toHaveBeenCalledTimes(2); expect(result.degraded).toBe(true);
    expect(result.results[0]!.vulnerabilities).toHaveLength(1);
  });
  it('bounds pages and marks truncated pagination incomplete', async () => {
    let page = 0;
    const transport = vi.fn(async () => ({ results: [{ vulns: [{ id: `OSV-${++page}` }], next_page_token: `page-${page}` }] }));
    const result = await new OsvClient({ transport, detailTransport: async endpoint => full(endpoint.split('/').pop()!) }).query([ref()]);
    expect(transport).toHaveBeenCalledTimes(OSV_LIMITS.pages); expect(result.degraded).toBe(true);
    expect(result.results[0]!.vulnerabilities).toHaveLength(OSV_LIMITS.pages);
  });
  it('bounds batch requests and package refs', async () => {
    const transport = vi.fn(async (_endpoint, body: OsvBatchRequest) => ({ results: body.queries.map(() => ({})) }));
    const result = await new OsvClient({ maxBatch: 1, transport }).query(Array.from({ length: 501 }, (_, n) => ref(String(n))));
    expect(transport).toHaveBeenCalledTimes(OSV_LIMITS.batches); expect(result.results).toHaveLength(OSV_LIMITS.refs);
    expect(result.degraded).toBe(true);
  });
  it('bounds detail requests and known IDs without dropping their existence', async () => {
    const detailTransport = vi.fn(async endpoint => full(endpoint.split('/').pop()!));
    const result = await new OsvClient({ transport: async () => bulk(...Array.from({ length: 501 }, (_, n) => `OSV-${n}`)), detailTransport }).query([ref()]);
    expect(detailTransport).toHaveBeenCalledTimes(OSV_LIMITS.details); expect(result.results[0]!.vulnerabilities).toHaveLength(OSV_LIMITS.ids);
    expect(result.results[0]!.vulnerabilities.filter(v => !v.severityKnown)).toHaveLength(OSV_LIMITS.ids - OSV_LIMITS.details);
    expect(result.degraded).toBe(true);
  });
  it('caps concurrent detail requests at six', async () => {
    let active = 0, peak = 0;
    const detailTransport = vi.fn(async endpoint => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2)); active--;
      return full(endpoint.split('/').pop()!);
    });
    const result = await new OsvClient({ transport: async () => bulk(...Array.from({ length: 20 }, (_, n) => `OSV-${n}`)), detailTransport }).query([ref()]);
    expect(peak).toBe(OSV_LIMITS.concurrency); expect(result.degraded).toBe(false);
  });
  it.each(['batch', 'detail'])('stops a noncooperative %s transport at its request deadline', async stage => {
    vi.useFakeTimers();
    const resultPromise = new OsvClient({ timeoutMs: 10, budgetMs: 100,
      transport: async () => stage === 'batch' ? new Promise(() => {}) : bulk('OSV-1'),
      detailTransport: async () => new Promise(() => {}),
    }).query([ref()]);
    await vi.advanceTimersByTimeAsync(11);
    const result = await resultPromise;
    expect(result.degraded).toBe(true); expect(result.results[0]!.complete).toBe(false);
    if (stage === 'detail') expect(result.results[0]!.vulnerabilities[0]).toMatchObject({ id: 'OSV-1', severityKnown: false });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('honors the whole-query deadline across successive requests', async () => {
    vi.useFakeTimers();
    const transport = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 7)); return bulk('OSV-1'); });
    const resultPromise = new OsvClient({ timeoutMs: 10, budgetMs: 15, maxBatch: 1, transport }).query([ref('a'), ref('b'), ref('c'), ref('d')]);
    await vi.advanceTimersByTimeAsync(16);
    const result = await resultPromise;
    expect(result.degraded).toBe(true); expect(transport).toHaveBeenCalledTimes(3);
  });
  it('honors cancellation without starting network requests for an already-aborted review', async () => {
    const controller = new AbortController(); controller.abort();
    const transport = vi.fn();
    expect((await new OsvClient({ transport }).query([ref()], controller.signal)).degraded).toBe(true);
    expect(transport).not.toHaveBeenCalled();
  });
  it('cancels in-flight details and does not launch further requests', async () => {
    const controller = new AbortController(), signals: AbortSignal[] = [];
    const detailTransport = vi.fn(async (_endpoint, signal: AbortSignal) => { signals.push(signal); return new Promise(() => {}); });
    const resultPromise = new OsvClient({ transport: async () => bulk(...Array.from({ length: 20 }, (_, n) => `OSV-${n}`)), detailTransport }).query([ref()], controller.signal);
    await vi.waitFor(() => expect(detailTransport).toHaveBeenCalledTimes(OSV_LIMITS.concurrency));
    controller.abort(); const result = await resultPromise;
    expect(result.degraded).toBe(true); expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(detailTransport).toHaveBeenCalledTimes(OSV_LIMITS.concurrency);
  });
  it('logs a fixed warning without upstream error bodies or URLs', async () => {
    await new OsvClient({ transport: async () => { throw new Error('private-package secret-token https://internal.example'); } }).query([ref()]);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(/private-package|secret-token|internal\.example/);
  });
});

describe('OSV default HTTP transports', () => {
  it('POSTs ID discovery then GETs full details from the same trusted mirror', async () => {
    const fetchMock = vi.fn(async (input: string) => Response.json(input.includes('querybatch') ? bulk('GHSA-example:1') : full('GHSA-example:1')));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new OsvClient({ endpoint: 'https://mirror.example/api/v1/querybatch' }).query([ref()]);
    expect(result.degraded).toBe(false);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://mirror.example/api/v1/querybatch');
    expect((fetchMock.mock.calls[0] as any)[1].method).toBe('POST');
    expect(fetchMock.mock.calls[1]![0]).toBe('https://mirror.example/api/v1/vulns/GHSA-example%3A1');
    expect((fetchMock.mock.calls[1] as any)[1].body).toBeUndefined();
  });
  it('rejects a path-like advisory ID without requesting another URL', async () => {
    const fetchMock = vi.fn(async () => Response.json(bulk('../../private'))); vi.stubGlobal('fetch', fetchMock);
    expect((await new OsvClient().query([ref()])).degraded).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it.each(['HTTP error', 'bad JSON', 'declared oversize', 'streamed oversize'])('preserves known IDs when detail has %s', async failure => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      if (input.includes('querybatch')) return Response.json(bulk('OSV-1'));
      if (failure === 'HTTP error') return new Response('unavailable', { status: 503 });
      if (failure === 'bad JSON') return new Response('broken JSON');
      if (failure === 'declared oversize') return new Response('{}', { headers: { 'content-length': String(OSV_LIMITS.responseBytes + 1) } });
      return new Response('x'.repeat(OSV_LIMITS.responseBytes + 1));
    }));
    const result = await new OsvClient().query([ref()]);
    expect(result).toMatchObject({ degraded: true, results: [{ complete: false, vulnerabilities: [{ id: 'OSV-1', severityKnown: false }] }] });
  });
  it('enforces the total response-byte budget across detail requests', async () => {
    const ids = Array.from({ length: 10 }, (_, n) => `OSV-${n}`);
    vi.stubGlobal('fetch', vi.fn(async (input: string) => Response.json(input.includes('querybatch') ? bulk(...ids)
      : { ...full(input.split('/').pop()!), padding: 'x'.repeat(OSV_LIMITS.responseBytes - 200) })));
    const result = await new OsvClient().query([ref()]);
    expect(result.degraded).toBe(true); expect(result.results[0]!.vulnerabilities).toHaveLength(10);
    expect(result.results[0]!.vulnerabilities.some(v => !v.severityKnown)).toBe(true);
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

  it('leaves severity unknown when nothing usable is present', () => {
    expect(osvSeverity({ severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N' }] })).toBeNull();
    expect(osvSeverity({})).toBeNull();
  });
});
