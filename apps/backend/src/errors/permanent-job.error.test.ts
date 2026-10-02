import { describe, it, expect } from 'vitest';
import { PermanentJobError, isPermanentJobError } from './permanent-job.error';

describe('PermanentJobError', () => {
  it('carries a machine-readable reason alongside the message', () => {
    const err = new PermanentJobError('missing-api-key', 'Save your key at /vault');

    expect(err.reason).toBe('missing-api-key');
    expect(err.message).toBe('Save your key at /vault');
    expect(err.name).toBe('PermanentJobError');
  });

  it('is a normal Error, so existing catch blocks keep working', () => {
    const err = new PermanentJobError('missing-api-key', 'nope');

    expect(err).toBeInstanceOf(Error);
    expect(err.stack).toBeTruthy();
  });

  describe('isPermanentJobError', () => {
    it('detects a PermanentJobError', () => {
      expect(isPermanentJobError(new PermanentJobError('r', 'm'))).toBe(true);
    });

    it('rejects a plain Error so transient failures still retry', () => {
      expect(isPermanentJobError(new Error('GitHub 502'))).toBe(false);
    });

    it('rejects non-Error values rather than throwing', () => {
      expect(isPermanentJobError('string failure')).toBe(false);
      expect(isPermanentJobError(undefined)).toBe(false);
      expect(isPermanentJobError(null)).toBe(false);
      expect(isPermanentJobError({ message: 'oops' })).toBe(false);
    });
  });
});