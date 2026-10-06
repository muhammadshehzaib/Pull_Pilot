import { describe, it, expect, vi } from 'vitest';

/**
 * privacy.ts reads its window from the environment at import time, so each
 * case reloads the module with the env it wants to exercise.
 */
async function load(env?: string) {
  vi.resetModules();
  if (env === undefined) delete process.env.NEXT_PUBLIC_CODE_RETENTION_HOURS;
  else process.env.NEXT_PUBLIC_CODE_RETENTION_HOURS = env;
  return import('./privacy');
}

describe('privacy copy', () => {
  describe('indefinite retention (shipped default)', () => {
    it('keeps code until the repository is disconnected', async () => {
      const m = await load('0');
      expect(m.CODE_RETAIN_INDEFINITELY).toBe(true);
      expect(m.retentionWindow()).toBeNull();
      expect(m.retentionPolicySentence()).toMatch(/stays connected/i);
    });

    it('never promises automatic deletion while retention is indefinite', async () => {
      const m = await load('0');
      for (const text of [m.codeHandlingSummary(), m.codeRetentionFaq()]) {
        expect(text).not.toMatch(/deleted automatically within/i);
        expect(text).toMatch(/stays connected/i);
      }
    });

    it('treats an unset window as indefinite, so the site matches the shipped default', async () => {
      const m = await load(undefined);
      expect(m.CODE_RETAIN_INDEFINITELY).toBe(true);
    });
  });

  describe('finite retention', () => {
    it('phrases whole days as days', async () => {
      const m = await load('168');
      expect(m.CODE_RETAIN_INDEFINITELY).toBe(false);
      expect(m.retentionWindow()).toBe('7 days');
    });

    it('phrases a single day as hours', async () => {
      const m = await load('24');
      expect(m.retentionWindow()).toBe('24 hours');
    });

    it('phrases a partial day as hours', async () => {
      const m = await load('36');
      expect(m.retentionWindow()).toBe('36 hours');
    });

    it('states the window in the copy whenever it is finite', async () => {
      const m = await load('24');
      expect(m.codeHandlingSummary()).toMatch(/24 hours/);
      expect(m.codeRetentionFaq()).toMatch(/24 hours/);
    });

    it('fails safe to a short window when the value is malformed', async () => {
      const m = await load('soon');
      expect(m.CODE_RETENTION_HOURS).toBe(24);
      expect(m.CODE_RETAIN_INDEFINITELY).toBe(false);
    });
  });

  describe('claims that must hold in every mode', () => {
    it('states that code is never used for training', async () => {
      const m = await load('0');
      expect(m.NO_TRAINING_CLAIM).toMatch(/never used to train/i);
    });

    it('does not claim code is never stored, because it is', async () => {
      // The old copy asserted "zero code retention" in eight places. Storing
      // encrypted context is what this feature does, so the claim had to go or
      // the site would misstate what happens to customer source code.
      for (const env of ['0', '24']) {
        const m = await load(env);
        for (const text of [m.NO_TRAINING_CLAIM, m.codeHandlingSummary(), m.codeRetentionFaq()]) {
          expect(text).not.toMatch(/never stored|no retention|zero retention|not store/i);
          expect(text).not.toMatch(
            /purged immediately|discarded immediately|only in RAM|volatile/i,
          );
        }
      }
    });

    it('discloses encryption wherever it describes storage', async () => {
      for (const env of ['0', '24']) {
        const m = await load(env);
        expect(m.codeHandlingSummary()).toMatch(/AES-256-GCM/);
        expect(m.codeRetentionFaq()).toMatch(/AES-256-GCM/);
      }
    });

    it('acknowledges that files are stored rather than hiding it', async () => {
      const m = await load('0');
      expect(m.codeRetentionFaq()).toMatch(/do store|encrypted at rest/i);
    });

    it('never says code is deleted if it is not', async () => {
      const indefinite = await load('0');
      expect(indefinite.codeHandlingSummary()).not.toMatch(/deleted within/i);
      expect(indefinite.codeRetentionFaq()).not.toMatch(/deleted within/i);
    });

    it('keeps the badge short enough for a footer line', async () => {
      const m = await load('0');
      expect(m.CODE_HANDLING_BADGE.length).toBeLessThan(40);
    });
  });
});