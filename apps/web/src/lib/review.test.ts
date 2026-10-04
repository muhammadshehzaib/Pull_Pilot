import { describe, expect, it } from 'vitest';
import {
  AGENT_LABELS,
  IN_PROGRESS_STATUSES,
  PRIORITY_COLORS,
  PRIORITY_ICONS,
  PRIORITY_LABELS,
  PRIORITY_ORDER,
  STATUS_COLORS,
  STATUS_LABELS,
  isBlocking,
  isInProgress,
  isTerminalFailure,
  statusLabel,
  tallyBySeverity,
  type JobStatus,
  type Priority,
} from './review';

/**
 * Every status the backend can persist. If the backend enum grows and this list
 * is not updated, the exhaustiveness tests below fail — that is the point.
 */
const ALL_STATUSES: JobStatus[] = [
  'QUEUED',
  'FETCHING',
  'ANALYZING',
  'GENERATING',
  'POSTING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
  'TIMEOUT',
];

describe('status maps', () => {
  it('labels and colours every backend status', () => {
    for (const status of ALL_STATUSES) {
      expect(STATUS_LABELS[status], `label for ${status}`).toBeTruthy();
      expect(STATUS_COLORS[status], `colour for ${status}`).toMatch(/^(var\(--|#)/);
    }
  });

  it('gives the four new review phases a distinct human label', () => {
    // A raw "GENERATING" told the user nothing about what the system was doing.
    expect(STATUS_LABELS.FETCHING).toBe('Fetching diff');
    expect(STATUS_LABELS.ANALYZING).toBe('Analyzing');
    expect(STATUS_LABELS.GENERATING).toBe('Building review');
    expect(STATUS_LABELS.POSTING).toBe('Posting comments');
  });
});

describe('statusLabel', () => {
  it('returns the curated label for a known status', () => {
    expect(statusLabel('ANALYZING')).toBe('Analyzing');
  });

  it('falls back to humanized text for a status this build has never seen', () => {
    expect(statusLabel('QUANTUM_REVIEW')).toBe('Quantum Review');
  });
});

describe('isInProgress', () => {
  it('covers every phase so polling cannot stop mid-review', () => {
    // Regression: the history page only checked RUNNING and QUEUED, so a review
    // that had reached ANALYZING was never refreshed again.
    for (const phase of ['QUEUED', 'FETCHING', 'ANALYZING', 'GENERATING', 'POSTING', 'RUNNING'] as JobStatus[]) {
      expect(isInProgress(phase), phase).toBe(true);
    }
  });

  it('excludes finished reviews', () => {
    for (const status of ['COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED', 'TIMEOUT'] as JobStatus[]) {
      expect(isInProgress(status), status).toBe(false);
    }
  });

  it('does not invent in-progress statuses', () => {
    expect(isInProgress('SOMETHING_NEW')).toBe(false);
  });
});

describe('isTerminalFailure', () => {
  it('separates failure from success', () => {
    expect(isTerminalFailure('FAILED')).toBe(true);
    expect(isTerminalFailure('CANCELLED')).toBe(true);
    expect(isTerminalFailure('TIMEOUT')).toBe(true);
    expect(isTerminalFailure('COMPLETED')).toBe(false);
    expect(isTerminalFailure('SKIPPED')).toBe(false);
  });

  it('does not treat an in-flight review as failed', () => {
    for (const status of IN_PROGRESS_STATUSES) {
      expect(isTerminalFailure(status), status).toBe(false);
    }
  });
});

describe('priority maps', () => {
  const levels: Priority[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

  it('labels, colours and icons every severity', () => {
    for (const level of levels) {
      expect(PRIORITY_LABELS[level], level).toBeTruthy();
      expect(PRIORITY_COLORS[level], level).toMatch(/^(var\(--|#)/);
      expect(PRIORITY_ICONS[level], level).toBeTruthy();
    }
  });

  it('orders severity most severe first, matching the backend SEVERITY_RANK', () => {
    const sorted = [...levels].sort((a, b) => PRIORITY_ORDER[a] - PRIORITY_ORDER[b]);
    expect(sorted).toEqual(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']);
  });
});

describe('isBlocking', () => {
  it('treats CRITICAL and HIGH as merge blockers', () => {
    expect(isBlocking('CRITICAL')).toBe(true);
    expect(isBlocking('HIGH')).toBe(true);
  });

  it('does not treat advisory severities as blockers', () => {
    expect(isBlocking('MEDIUM')).toBe(false);
    expect(isBlocking('LOW')).toBe(false);
    expect(isBlocking('INFO')).toBe(false);
  });
});

describe('tallyBySeverity', () => {
  it('returns nothing for an empty review so the badge row can be hidden', () => {
    expect(tallyBySeverity([])).toEqual([]);
  });

  it('counts per severity and omits empty levels', () => {
    const tally = tallyBySeverity([
      { priority: 'HIGH' },
      { priority: 'HIGH' },
      { priority: 'LOW' },
    ]);
    expect(tally.map((entry) => [entry.level, entry.count])).toEqual([
      ['HIGH', 2],
      ['LOW', 1],
    ]);
  });

  it('orders the tally most severe first regardless of input order', () => {
    const tally = tallyBySeverity([{ priority: 'INFO' }, { priority: 'CRITICAL' }, { priority: 'HIGH' }]);
    expect(tally.map((entry) => entry.level)).toEqual(['CRITICAL', 'HIGH', 'INFO']);
  });

  it('carries presentation data alongside each count', () => {
    const [entry] = tallyBySeverity([{ priority: 'CRITICAL' }]);
    expect(entry).toMatchObject({ level: 'CRITICAL', label: 'Critical', count: 1 });
    expect(entry.icon).toBeTruthy();
    expect(entry.color).toMatch(/^(var\(--|#)/);
  });
});

describe('AGENT_LABELS', () => {
  it('labels the STYLE category added in the taxonomy change', () => {
    expect(AGENT_LABELS.STYLE).toBe('Style');
  });
});