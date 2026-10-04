import { describe, expect, it } from 'vitest';
import {
  countBySeverity,
  isBlockingSeverity,
  renderFindingListItem,
  renderInlineComment,
  severityBadge,
  severityTally,
} from './finding-format';
import type { AiSuggestion } from './finding-taxonomy';

const finding = (over: Partial<AiSuggestion> = {}): AiSuggestion => ({
  filePath: 'src/foo.ts',
  lineNumber: 12,
  agentType: 'SECURITY',
  issue: 'User input reaches a shell exec',
  suggestion: 'use execFile',
  priority: 'HIGH',
  ...over,
});

describe('severityBadge', () => {
  it('renders a glyph plus a readable label', () => {
    expect(severityBadge('CRITICAL')).toBe('🔴 Critical');
  });

  it('normalizes aliases to the canonical badge', () => {
    expect(severityBadge('blocker')).toBe(severityBadge('CRITICAL'));
  });

  it('falls back to INFO for unknown input rather than rendering garbage', () => {
    expect(severityBadge('not-a-severity')).toBe('⚪ Info');
    expect(severityBadge(undefined)).toBe('⚪ Info');
  });
});

describe('countBySeverity', () => {
  it('always returns every severity level, zero-filled', () => {
    expect(countBySeverity([])).toEqual({
      CRITICAL: 0,
      HIGH: 0,
      MEDIUM: 0,
      LOW: 0,
      INFO: 0,
    });
  });

  it('tallies a mixed set', () => {
    const counts = countBySeverity([
      finding({ priority: 'CRITICAL' }),
      finding({ priority: 'HIGH' }),
      finding({ priority: 'HIGH' }),
    ]);
    expect(counts.CRITICAL).toBe(1);
    expect(counts.HIGH).toBe(2);
  });
});

describe('severityTally', () => {
  it('omits severities with no findings and orders most severe first', () => {
    const tally = severityTally([
      finding({ priority: 'LOW' }),
      finding({ priority: 'CRITICAL' }),
      finding({ priority: 'LOW' }),
    ]);
    expect(tally).toBe('🔴 1 · 🔵 2');
  });

  it('returns an empty string when there is nothing to report', () => {
    expect(severityTally([])).toBe('');
  });
});

describe('renderInlineComment', () => {
  it('leads with severity and category so a reviewer can triage while scanning', () => {
    const body = renderInlineComment(finding());
    expect(body.split('\n')[0]).toBe('### 🟠 High SECURITY');
    expect(body).toContain('**Security:** User input reaches a shell exec');
  });

  it('emits the suggestion as a GitHub suggestion block', () => {
    expect(renderInlineComment(finding())).toContain('```suggestion\nuse execFile\n```');
  });

  it('underscores that STYLE is cosmetic, not a defect', () => {
    expect(renderInlineComment(finding({ agentType: 'STYLE', priority: 'INFO' }))).toContain('⚪ Info STYLE');
  });
});

describe('renderFindingListItem', () => {
  it('is numbered from one and cites file and line', () => {
    expect(renderFindingListItem(finding(), 0)).toContain('1. **🟠 High** `src/foo.ts:12`');
  });

  it('flattens a multi-line suggestion onto one line', () => {
    const body = renderFindingListItem(finding({ suggestion: '\n\nconst x = 1;\nconst y = 2;' }), 0);
    expect(body).toContain('**Fix:** const x = 1;');
    expect(body).not.toContain('const y = 2;');
  });

  it('truncates an unreasonably long suggestion', () => {
    const body = renderFindingListItem(finding({ suggestion: 'z'.repeat(400) }), 0);
    expect(body).toContain('...');
    expect(body.length).toBeLessThan(400);
  });
});

describe('isBlockingSeverity', () => {
  it('treats CRITICAL and HIGH as blocking', () => {
    expect(isBlockingSeverity(finding({ priority: 'CRITICAL' }))).toBe(true);
    expect(isBlockingSeverity(finding({ priority: 'HIGH' }))).toBe(true);
  });

  it('does not treat MEDIUM or lower as blocking', () => {
    expect(isBlockingSeverity(finding({ priority: 'MEDIUM' }))).toBe(false);
    expect(isBlockingSeverity(finding({ priority: 'INFO' }))).toBe(false);
  });
});