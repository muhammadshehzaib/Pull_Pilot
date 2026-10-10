import type { Request, Response, NextFunction } from 'express';
// Per-process abuse guard; bounded memory. Multi-instance deployments should also
// enforce an authenticated-user limit at the gateway. Never key by user content.
const buckets = new Map<string, { start: number; count: number }>();
export function feedbackRateLimit(req: Request, res: Response, next: NextFunction) {
  const key = req.auth!.userId;
  const now = Date.now();
  const bucket = buckets.get(key);
  if (bucket && now - bucket.start < 60000) {
    if (++bucket.count > 60) return res.status(429).set('Retry-After', '60').json({ error: 'Too many feedback operations; retry shortly' });
  } else {
    if (buckets.size >= 5000) buckets.delete(buckets.keys().next().value!);
    buckets.set(key, { start: now, count: 1 });
  }
  next();
}
