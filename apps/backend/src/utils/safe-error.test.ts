import { describe, it, expect, vi } from 'vitest';
import { safeErrorMetadata } from './safe-error';

describe('safeErrorMetadata', () => {
  it('keeps only bounded status and recognized error codes without serializing errors', () => {
    const toJSON = vi.fn(() => { throw new Error('must never serialize'); });
    const error = Object.assign(new Error('private-client-secret'), {
      code: 'ECONNRESET', status: 503,
      response: { status: 502, data: 'private-token', headers: { authorization: 'private-token' } },
      config: { data: 'private-client-secret', url: 'https://example.com/?code=private-code' },
      cause: new Error('private-token'), toJSON,
    });
    expect(safeErrorMetadata(error)).toEqual({ status: 502, code: 'ECONNRESET' });
    expect(toJSON).not.toHaveBeenCalled();
  });

  it.each([null, undefined, 'private-token', 42, new Error('private-token')])('omits arbitrary error details: %#', error => {
    expect(safeErrorMetadata(error)).toEqual({});
  });

  it.each(['502', 0, 99, 600, 502.5, Infinity, NaN, { secret: 'private-token' }])('rejects invalid HTTP status metadata: %#', status => {
    expect(safeErrorMetadata({ response: { status } })).toEqual({});
  });

  it.each(['private-token', 'ERR_BAD_REQUEST\nprivate-token', 502, { token: 'private-token' }])('rejects unknown or malformed error codes: %#', code => {
    expect(safeErrorMetadata({ code })).toEqual({});
  });

  it('accepts a numeric status from an Octokit-style error', () => {
    expect(safeErrorMetadata({ status: 403, request: { headers: { authorization: 'private-token' } } })).toEqual({ status: 403 });
  });
});
