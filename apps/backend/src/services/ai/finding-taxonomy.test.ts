import { describe, it, expect } from 'vitest';
import {
  normalizeSeverity,
  normalizeCategory,
  normalizeSuggestions,
  sortBySeverity,
  SEVERITY_RANK,
  FINDING_SEVERITIES,
  FINDING_CATEGORIES,
} from './finding-taxonomy';

const base = {
  filePath: 'src/a.ts',
  lineNumber: 10,
  issue: 'issue',
  suggestion: 'fix',
};

describe('normalizeSeverity', () => {
  it('accepts all five canonical levels', () => {
    for (const level of FINDING_SEVERITIES) {
      expect(normalizeSeverity(level)).toBe(level);
    }
  });

  it('is case and whitespace insensitive', () => {
    expect(normalizeSeverity('  critical ')).toBe('CRITICAL');
    expect(normalizeSeverity('Medium')).toBe('MEDIUM');
  });

  it('maps common synonyms onto canonical levels', () => {
    expect(normalizeSeverity('blocker')).toBe('CRITICAL');
    expect(normalizeSeverity('major')).toBe('HIGH');
    expect(normalizeSeverity('error')).toBe('HIGH');
    expect(normalizeSeverity('warning')).toBe('MEDIUM');
    expect(normalizeSeverity('nit')).toBe('INFO');
  });

  it('returns null for values it cannot map', () => {
    expect(normalizeSeverity('SEVEREISH')).toBeNull();
    expect(normalizeSeverity(undefined)).toBeNull();
    expect(normalizeSeverity(7)).toBeNull();
  });
});

describe('normalizeCategory', () => {
  it('accepts all canonical categories', () => {
    for (const category of FINDING_CATEGORIES) {
      expect(normalizeCategory(category)).toBe(category);
    }
  });

  it('maps legacy and synonym categories', () => {
    expect(normalizeCategory('BUG_RISK')).toBe('BUG');
    expect(normalizeCategory('CLEANUP')).toBe('MAINTAINABILITY');
    expect(normalizeCategory('type safety')).toBe('CORRECTNESS');
    expect(normalizeCategory('TESTS')).toBe('TESTING');
  });

  it('keeps cosmetic feedback separate from maintainability', () => {
    expect(normalizeCategory('STYLE')).toBe('STYLE');
    expect(normalizeCategory('FORMATTING')).toBe('STYLE');
  });

  it('returns null for unknown categories', () => {
    expect(normalizeCategory('ASTROLOGY')).toBeNull();
    expect(normalizeCategory(null)).toBeNull();
  });
});

describe('SEVERITY_RANK', () => {
  it('orders severities from most to least severe', () => {
    expect(SEVERITY_RANK.CRITICAL).toBeGreaterThan(SEVERITY_RANK.HIGH);
    expect(SEVERITY_RANK.HIGH).toBeGreaterThan(SEVERITY_RANK.MEDIUM);
    expect(SEVERITY_RANK.MEDIUM).toBeGreaterThan(SEVERITY_RANK.LOW);
    expect(SEVERITY_RANK.LOW).toBeGreaterThan(SEVERITY_RANK.INFO);
  });
});

describe('sortBySeverity', () => {
  it('sorts most severe first', () => {
    const sorted = sortBySeverity([
      { priority: 'INFO' },
      { priority: 'CRITICAL' },
      { priority: 'MEDIUM' },
      { priority: 'HIGH' },
    ]);

    expect(sorted.map((s) => s.priority)).toEqual([
      'CRITICAL',
      'HIGH',
      'MEDIUM',
      'INFO',
    ]);
  });

  it('does not mutate the input array', () => {
    const input = [{ priority: 'LOW' }, { priority: 'CRITICAL' }];
    sortBySeverity(input);
    expect(input.map((s) => s.priority)).toEqual(['LOW', 'CRITICAL']);
  });
});

describe('normalizeSuggestions', () => {
  it('returns an empty array for non-array input', () => {
    expect(normalizeSuggestions(null)).toEqual([]);
    expect(normalizeSuggestions('nope')).toEqual([]);
    expect(normalizeSuggestions({ suggestions: [] })).toEqual([]);
  });

  it('keeps well-formed findings', () => {
    const out = normalizeSuggestions([
      { ...base, agentType: 'SECURITY', priority: 'HIGH' },
    ]);

    expect(out).toEqual([
      { ...base, agentType: 'SECURITY', priority: 'HIGH' },
    ]);
  });

  it('drops findings that cannot be rendered or acted on', () => {
    const out = normalizeSuggestions([
      { ...base, agentType: 'SECURITY', priority: 'HIGH' },
      { ...base, filePath: '', agentType: 'SECURITY', priority: 'HIGH' },
      { ...base, issue: undefined, agentType: 'SECURITY', priority: 'HIGH' },
      { ...base, suggestion: '', agentType: 'SECURITY', priority: 'HIGH' },
      null,
      'garbage',
      42,
    ]);

    expect(out).toHaveLength(1);
    expect(out[0].filePath).toBe('src/a.ts');
  });

  it('coerces aliases onto the canonical vocabulary', () => {
    const out = normalizeSuggestions([
      { ...base, agentType: 'BUG_RISK', priority: 'blocker' },
    ]);

    expect(out[0].agentType).toBe('BUG');
    expect(out[0].priority).toBe('CRITICAL');
  });

  it('downgrades an unrecognised severity to INFO rather than dropping the finding', () => {
    const out = normalizeSuggestions([
      { ...base, agentType: 'SECURITY', priority: 'EXTREMELY_BAD' },
    ]);

    expect(out).toHaveLength(1);
    expect(out[0].priority).toBe('INFO');
  });

  it('defaults an unrecognised category rather than dropping the finding', () => {
    const out = normalizeSuggestions([
      { ...base, agentType: 'ASTROLOGY', priority: 'HIGH' },
    ]);

    expect(out[0].agentType).toBe('MAINTAINABILITY');
  });

  it('fills in a missing severity', () => {
    const out = normalizeSuggestions([{ ...base, agentType: 'BUG' }]);
    expect(out[0].priority).toBe('INFO');
  });

  it('preserves findings with invalid numbers for summaries without guessing an integer line', () => {
    const out = normalizeSuggestions([
      { ...base, lineNumber: 12.9, agentType: 'BUG', priority: 'LOW' },
      { ...base, lineNumber: 'abc', agentType: 'BUG', priority: 'LOW' },
    ]);

    expect(out).toHaveLength(2);
    expect(out[0].lineNumber).toBe(0);
    expect(out[1].lineNumber).toBe(0);
  });

  it('trims whitespace from text fields', () => {
    const out = normalizeSuggestions([
      { ...base, filePath: '  src/a.ts  ', issue: '  bad  ', suggestion: '  fix  ', agentType: 'BUG', priority: 'LOW' },
    ]);

    expect(out[0]).toMatchObject({
      filePath: 'src/a.ts',
      issue: 'bad',
      suggestion: 'fix',
    });
  });
});
