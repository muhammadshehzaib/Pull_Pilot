import type { ErrorRequestHandler } from 'express';
import { safeErrorMetadata } from '../utils/safe-error';

/** Express 5 forwards rejected async handlers here; never expose upstream text. */
export const apiErrorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const metadata = safeErrorMetadata(error);
  if (metadata.status === 413 && error?.type === 'entity.too.large') {
    const diagnostics: { status: number; limitBytes?: number; receivedBytes?: number } = { status: 413 };
    // Allow only size counters, never parser messages or the rejected body.
    if (Number.isSafeInteger(error.limit) && error.limit >= 0) diagnostics.limitBytes = error.limit;
    const received = error.length ?? error.received;
    if (Number.isSafeInteger(received) && received >= 0) diagnostics.receivedBytes = received;
    console.warn('Request body rejected: size limit exceeded', diagnostics);
    if (res.headersSent) { res.end(); return; }
    res.status(413).json({
      error: 'Request body exceeds the allowed size limit.',
      code: 'PAYLOAD_TOO_LARGE',
      ...(diagnostics.limitBytes === undefined ? {} : { limitBytes: diagnostics.limitBytes }),
    });
    return;
  }
  console.error('API request failed', metadata);
  if (res.headersSent) { res.end(); return; }
  const status = metadata.status && metadata.status >= 400 ? metadata.status : 500;
  res.status(status).json({ error: 'Request could not be completed. Please retry.' });
};
