import type { ErrorRequestHandler } from 'express';
import { safeErrorMetadata } from '../utils/safe-error';

/** Express 5 forwards rejected async handlers here; never expose upstream text. */
export const apiErrorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const metadata = safeErrorMetadata(error);
  console.error('API request failed', metadata);
  if (res.headersSent) { res.end(); return; }
  const status = metadata.status && metadata.status >= 400 ? metadata.status : 500;
  res.status(status).json({ error: 'Request could not be completed. Please retry.' });
};
