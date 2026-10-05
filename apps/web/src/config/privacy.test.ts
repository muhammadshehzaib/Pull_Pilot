import { describe, it, expect } from 'vitest';

import {
  CODE_HANDLING_BADGE,
  CODE_RETENTION_HOURS,
  NO_TRAINING_CLAIM,
  codeHandlingSummary,
  codeRetentionFaq,
  retentionWindow,
} from './privacy';

describe('privacy copy', () => {
  describe('retentionWindow()', () => {
    it('phrases a whole number of days as days', () => {
      expect(retentionWindow()).toMatch(/(hours|days)$/);
    });

    it('never prints a fraction or a zero window', () => {
      expect(retentionWindow()).not.toContain('.');
      expect(CODE_RETENTION_HOURS).toBeGreaterThan(0);
    });
  });

  describe('claims', () => {
    it('states that code is never used for training', () => {
      expect(NO_TRAINING_CLAIM).toMatch(/never used to train/i);
    });

    it('does not claim code is never stored, because it is', () => {
      // The old copy asserted "zero code retention" in eight places. Storing
      // encrypted context is what this feature does, so the claim has to go or
      // the site misstates what happens to customer source code.
      for (const text of [NO_TRAINING_CLAIM, codeHandlingSummary(), codeRetentionFaq()]) {
        expect(text).not.toMatch(/never stored|no retention|zero retention|not store/i);
        expect(text).not.toMatch(/purged immediately|discarded immediately|only in RAM|volatile/i);
      }
    });

    it('discloses encryption and deletion wherever it describes storage', () => {
      expect(codeHandlingSummary()).toMatch(/AES-256-GCM/);
      expect(codeHandlingSummary()).toMatch(new RegExp(retentionWindow()));

      expect(codeRetentionFaq()).toMatch(/AES-256-GCM/);
      expect(codeRetentionFaq()).toMatch(new RegExp(retentionWindow()));
    });

    it('acknowledges that files are stored rather than hiding it', () => {
      // Being straight about storage is the point; the differentiator is
      // encryption, deletion and no training.
      expect(codeRetentionFaq()).toMatch(/do store|encrypted at rest/i);
    });

    it('uses the same window everywhere, so the site cannot contradict itself', () => {
      const window = retentionWindow();
      expect(codeHandlingSummary()).toContain(window);
      expect(codeRetentionFaq()).toContain(window);
    });
  });

  it('keeps the badge short enough for a footer line', () => {
    expect(CODE_HANDLING_BADGE.length).toBeLessThan(40);
  });
});