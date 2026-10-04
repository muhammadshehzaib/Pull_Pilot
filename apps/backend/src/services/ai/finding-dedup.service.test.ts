import { describe, it, expect } from 'vitest';
import { deduplicate, fingerprint } from './finding-dedup.service';
import { AiSuggestion } from './finding-taxonomy';

function finding(overrides: Partial<AiSuggestion> = {}): AiSuggestion {
  return {
    filePath: 'src/payment.service.ts',
    lineNumber: 42,
    agentType: 'BUG',
    issue: 'Unchecked user.id may be null',
    suggestion: 'Guard with if (!user.id) throw',
    priority: 'MEDIUM',
    ...overrides,
  };
}

describe('fingerprint', () => {
  it('folds code identifiers to a placeholder', () => {
    const a = fingerprint('user.id is not validated');
    const b = fingerprint('payment.amount is not validated');
    expect(a).toBe(b);
  });

  it('drops punctuation and stopwords', () => {
    expect(fingerprint('The value, is; null!')).toBe(fingerprint('value null'));
  });

  it('keeps words that carry meaning apart', () => {
    expect(fingerprint('missing transaction')).not.toBe(fingerprint('missing validation'));
  });
});

describe('deduplicate', () => {
  it('returns an empty array untouched', () => {
    expect(deduplicate([])).toEqual([]);
  });

  it('returns a single finding untouched', () => {
    const only = finding();
    expect(deduplicate([only])).toEqual([only]);
  });

  it('collapses byte-identical repeats', () => {
    const input = [finding(), finding()];
    expect(deduplicate(input)).toHaveLength(1);
  });

  it('does not mutate the input array', () => {
    const input = [finding(), finding()];
    deduplicate(input);
    expect(input).toHaveLength(2);
  });

  it('merges the same issue reported on adjacent lines', () => {
    const input = [
      finding({ lineNumber: 42 }),
      finding({ lineNumber: 44, issue: 'Unchecked user.id may be null here' }),
    ];
    expect(deduplicate(input)).toHaveLength(1);
  });

  it('keeps the lowest cited line so the reader jumps to the right place', () => {
    const input = [finding({ lineNumber: 44 }), finding({ lineNumber: 42 })];
    expect(deduplicate(input)[0].lineNumber).toBe(42);
  });

  it('keeps the strongest severity when merging', () => {
    const input = [
      finding({ priority: 'MEDIUM', issue: 'SQL injection via string concatenation' }),
      finding({
        priority: 'CRITICAL',
        issue: 'SQL injection caused by string concatenation',
        suggestion: 'Use a parameterised query instead',
      }),
    ];
    expect(deduplicate(input)[0].priority).toBe('CRITICAL');
  });

  it('keeps the longer suggestion text', () => {
    const input = [
      finding({ suggestion: 'short' }),
      finding({ suggestion: 'a considerably longer and more useful explanation' }),
    ];
    expect(deduplicate(input)[0].suggestion).toContain('considerably longer');
  });

  it('preserves distinct issues in the same file and category', () => {
    const input = [
      finding({ lineNumber: 10, issue: 'missing transaction' }),
      finding({ lineNumber: 80, issue: 'unhandled promise rejection' }),
    ];
    expect(deduplicate(input)).toHaveLength(2);
  });

  it('preserves distinct categories on the same line', () => {
    const input = [
      finding({ lineNumber: 10, agentType: 'BUG', issue: 'same words here' }),
      finding({ lineNumber: 10, agentType: 'SECURITY', issue: 'same words here' }),
    ];
    expect(deduplicate(input)).toHaveLength(2);
  });

  it('preserves the same issue across different files', () => {
    const input = [
      finding({ filePath: 'src/a.ts' }),
      finding({ filePath: 'src/b.ts' }),
    ];
    expect(deduplicate(input)).toHaveLength(2);
  });

  it('treats a reworded report of one problem as a duplicate', () => {
    const input = [
      finding({ issue: 'SQL injection via string concatenation' }),
      finding({ lineNumber: 43, issue: 'SQL injection caused by string concatenation' }),
    ];
    expect(deduplicate(input)).toHaveLength(1);
  });

  it('keeps two problems on the same line that only share a word', () => {
    const input = [
      finding({ issue: 'unhandled promise rejection' }),
      finding({ issue: 'missing transaction rollback' }),
    ];
    expect(deduplicate(input)).toHaveLength(2);
  });

  it('preserves input order of the survivors', () => {
    const input = [
      finding({ lineNumber: 5, issue: 'first problem entirely' }),
      finding({ lineNumber: 900, issue: 'second problem entirely' }),
      finding({ lineNumber: 5, issue: 'first problem entirely' }),
    ];
    const out = deduplicate(input);
    expect(out).toHaveLength(2);
    expect(out[0].lineNumber).toBe(5);
    expect(out[1].lineNumber).toBe(900);
  });
});
