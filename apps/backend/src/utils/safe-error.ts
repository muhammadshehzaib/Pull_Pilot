const SAFE_ERROR_CODES = new Set([
  'ERR_BAD_REQUEST', 'ERR_BAD_RESPONSE', 'ERR_NETWORK', 'ERR_CANCELED',
  'ECONNABORTED', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
]);

/** Build fresh, bounded diagnostics; never log arbitrary HTTP error contents. */
export function safeErrorMetadata(error: unknown): { status?: number; code?: string } {
  const metadata: { status?: number; code?: string } = {};
  if (!error || typeof error !== 'object') return metadata;
  const input = error as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  const status = input.response?.status ?? input.status;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) {
    metadata.status = status;
  }
  if (typeof input.code === 'string' && SAFE_ERROR_CODES.has(input.code)) metadata.code = input.code;
  return metadata;
}
