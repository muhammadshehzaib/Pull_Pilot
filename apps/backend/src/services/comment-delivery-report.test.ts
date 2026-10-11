import { describe, expect, it } from 'vitest';
import { commentDeliveryReport } from './comment-delivery-report';
import { reviewBackoff } from './review-backoff';
import { classifyCommentError } from './github.service';

describe('comment delivery reporting and retry decisions', () => {
  it('keeps unknown, rejected, pending, and delivered counts separate and filters links', () => {
    const report = commentDeliveryReport([
      { kind: 'INLINE', state: 'UNKNOWN', reason: 'delivery-unconfirmed', githubUrl: null },
      { kind: 'INLINE', state: 'DELIVERED', reason: null, githubUrl: 'https://github.com/o/r/pull/1#comment' },
      { kind: 'INLINE', state: 'REJECTED', reason: 'github-validation-rejected', githubUrl: 'javascript:alert(1)' },
      { kind: 'INLINE', state: 'SENDING', reason: null, githubUrl: null },
      { kind: 'SUMMARY', state: 'WAITING', reason: null, githubUrl: null },
    ]);
    expect(report).toMatchObject({ expected: 4, delivered: 1, rejected: 1, unconfirmed: 1, pending: 1, summary: 'WAITING' });
    expect(report.links).toEqual(['https://github.com/o/r/pull/1#comment']);
  });
  it.each([new Error('timeout'), { status: 500 }, { status: 502 }])('never treats an uncertain send as safe to retry', error => {
    expect(classifyCommentError(error)).toMatchObject({ ok: false, failure: 'UNKNOWN' });
  });
  it.each([400, 401, 403, 404, 410, 422])('classifies definite HTTP %i rejections', status => {
    expect(classifyCommentError({ status })).toMatchObject({ failure: 'REJECTED', status });
  });
  it('does not confuse secondary rate limits/spam protection with invalid diff locations', () => {
    expect(classifyCommentError({ status: 422, message: 'You have triggered spam protection' })).toMatchObject({ failure: 'RETRYABLE' });
    const result = classifyCommentError({ status: 403, response: { headers: { 'retry-after': '120' } } });
    expect(result.failure).toBe('RETRYABLE');
    expect(reviewBackoff(1, 'review', Object.assign(new Error('rate limit'), { retryAt: result.retryAt }))).toBeGreaterThan(119_000);
  });
  it('keeps ordinary review retries exponential', () => {
    expect(reviewBackoff(1)).toBe(1000); expect(reviewBackoff(2)).toBe(2000);
  });
});
