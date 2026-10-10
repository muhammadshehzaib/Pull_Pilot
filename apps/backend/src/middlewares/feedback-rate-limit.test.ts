import { afterEach, expect, it, vi } from 'vitest';
import { feedbackRateLimit } from './feedback-rate-limit';
import { mockReq, mockRes } from '../test-utils/express-mocks';
afterEach(() => { vi.useRealTimers(); });
it('bounds per-user feedback operations, isolates users, and permits retry after the window', () => {
  vi.useFakeTimers(); const next = vi.fn(); const res = mockRes() as any; res.set = vi.fn().mockReturnValue(res);
  const req = Object.assign(mockReq(), { auth: { userId: 'limited-owner' } });
  for (let i = 0; i < 61; i++) feedbackRateLimit(req, res, next);
  expect(next).toHaveBeenCalledTimes(60); expect(res.status).toHaveBeenCalledWith(429);
  expect(res.set).toHaveBeenCalledWith('Retry-After', '60');
  feedbackRateLimit(Object.assign(mockReq(), { auth: { userId: 'other-owner' } }), res, next);
  expect(next).toHaveBeenCalledTimes(61);
  vi.advanceTimersByTime(60001); feedbackRateLimit(req, res, next); expect(next).toHaveBeenCalledTimes(62);
});
