import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from './api';
import { BACKEND_URL } from '../utils/constants';

function jsonResponse(body: unknown, init: { status?: number; statusText?: string } = {}) {
  const text = body === null ? '' : JSON.stringify(body);
  return new Response(text, {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('api()', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  beforeEach(() => {
    fetchSpy.mockReset();
  });

  afterEach(() => {
    fetchSpy.mockReset();
  });

  describe('happy path', () => {
    it('returns parsed JSON body on 200', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: true, n: 1 }));

      const out = await api<{ ok: boolean; n: number }>('/api/ping');

      expect(out).toEqual({ ok: true, n: 1 });
    });

    it('prepends BACKEND_URL to the path', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({}));

      await api('/api/foo');

      expect(fetchSpy).toHaveBeenCalledWith(
        `${BACKEND_URL}/api/foo`,
        expect.any(Object),
      );
    });

    it('sends credentials: "include" (cookies cross-origin)', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({}));

      await api('/api/foo');

      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.credentials).toBe('include');
    });

    it('sets Content-Type: application/json by default', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({}));

      await api('/api/foo');

      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>)['Content-Type']).toBe(
        'application/json',
      );
    });

    it('merges caller-supplied headers with the default Content-Type', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({}));

      await api('/api/foo', { headers: { 'X-Trace-Id': 'abc' } });

      const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<
        string,
        string
      >;
      expect(headers['X-Trace-Id']).toBe('abc');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('lets caller override Content-Type', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({}));

      await api('/api/foo', { headers: { 'Content-Type': 'text/plain' } });

      const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<
        string,
        string
      >;
      expect(headers['Content-Type']).toBe('text/plain');
    });

    it('forwards method and body to fetch', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({}));

      await api('/api/foo', { method: 'POST', body: JSON.stringify({ x: 1 }) });

      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ x: 1 }));
    });

    it('returns null when the response body is an empty string', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('', { status: 200, statusText: 'OK' }),
      );

      const out = await api('/api/foo');
      expect(out).toBeNull();
    });
  });

  describe('error path', () => {
    it('throws an ApiError-shaped object on non-2xx', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ error: 'bad input' }, { status: 400, statusText: 'Bad Request' }),
      );

      await expect(api('/api/foo')).rejects.toEqual({
        status: 400,
        error: 'bad input',
      });
    });

    it('falls back to statusText when body has no error field', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ note: 'something' }, { status: 503, statusText: 'Service Unavailable' }),
      );

      await expect(api('/api/foo')).rejects.toEqual({
        status: 503,
        error: 'Service Unavailable',
      });
    });

    it('falls back to statusText when body is empty on error response', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('', { status: 401, statusText: 'Unauthorized' }),
      );

      await expect(api('/api/foo')).rejects.toEqual({
        status: 401,
        error: 'Unauthorized',
      });
    });

    it('propagates fetch network errors', async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));

      await expect(api('/api/foo')).rejects.toThrow(/Failed to fetch/);
    });

    it('throws synchronously parseable error (so callers can use try/catch on JSON)', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('{not-json', { status: 500, statusText: 'Server Error' }),
      );

      await expect(api('/api/foo')).rejects.toThrow();
    });
  });
});
