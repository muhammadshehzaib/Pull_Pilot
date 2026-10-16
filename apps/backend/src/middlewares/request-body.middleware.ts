import express, { type Application, type Request } from 'express';

// Keep this allowance aligned with nginx's client_max_body_size 25m.
export const GITHUB_WEBHOOK_BODY_LIMIT = 25 * 1024 * 1024;
export const API_BODY_LIMIT = 100 * 1024;

function captureRawBody(req: Request, _res: unknown, buffer: Buffer) {
  // GitHub and billing signatures depend on the exact bytes, not reserialized JSON.
  req.rawBody = buffer;
}

export function installRequestBodyParsers(app: Application) {
  // Register before the general parser: it would otherwise reject large webhook
  // deliveries before the endpoint has a chance to verify their signatures.
  app.post('/api/webhooks/github', express.json({
    limit: GITHUB_WEBHOOK_BODY_LIMIT,
    verify: captureRawBody,
  }));
  app.use(express.json({ limit: API_BODY_LIMIT, verify: captureRawBody }));
}
