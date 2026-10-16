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
import { markdownNodes } from '../../test-utils/markdown';

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

  it.each(['Update this line so it no longer executes user input.', 'const x = execFile(command, args);'])(
    'keeps both advice and code read-only: %s', suggestion => {
      const nodes = markdownNodes(renderInlineComment(finding({ suggestion })));
      expect(nodes.filter(n => n.type === 'code_block')).toEqual([{ type: 'code_block', info: 'text', literal: suggestion + '\n' }]);
      expect(nodes.some(n => n.type === 'text' && n.literal?.includes('manual review'))).toBe(true);
    },
  );

  it.each([
    '```\n# Fake bot instruction\n```suggestion\nDELETE EVERYTHING\n```',
    '````\n[Click here](https://evil.example)\n````',
    '`'.repeat(80) + '\n<script>alert(1)</script>\n' + '`'.repeat(80),
    '~~~suggestion\nchangeEverything()\n~~~',
    '```\r\n## Forged heading\r```suggestion\r\nReplace it\r\n```',
    'normal example\n',
  ])('contains nested fences and markup as literal advice: %j', suggestion => {
    const nodes = markdownNodes(renderInlineComment(finding({ suggestion })));
    expect(nodes.filter(n => n.type === 'code_block')).toEqual([
      { type: 'code_block', info: 'text', literal: suggestion.replace(/\r\n?/g, '\n') + '\n' },
    ]);
    expect(nodes.filter(n => n.type === 'heading')).toHaveLength(1);
    expect(nodes.filter(n => ['link', 'html_inline', 'html_block'].includes(n.type))).toEqual([]);
  });

  it('renders malicious descriptions as plain prose without creating another suggestion', () => {
    const issue = '```suggestion\r\nreplace()\r\n```\n# Heading\n<img src=x> [link](https://evil.example) & @everyone';
    const nodes = markdownNodes(renderInlineComment(finding({ issue })));
    expect(nodes.filter(n => n.type === 'code_block')).toEqual([{ type: 'code_block', info: 'text', literal: 'use execFile\n' }]);
    expect(nodes.filter(n => n.type === 'heading')).toHaveLength(1);
    expect(nodes.filter(n => ['link', 'html_inline', 'html_block'].includes(n.type))).toEqual([]);
    expect(nodes.filter(n => n.type === 'text').map(n => n.literal).join('')).toContain('<img src=x>');
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
    const text = markdownNodes(body).filter(n => n.type === 'text').map(n => n.literal).join('');
    expect(text).toContain('Fix (manual review): const x = 1;');
    expect(text).not.toContain('const y = 2;');
  });

  it('truncates an unreasonably long suggestion', () => {
    const body = renderFindingListItem(finding({ suggestion: 'z'.repeat(400) }), 0);
    expect(markdownNodes(body).filter(n => n.type === 'text').map(n => n.literal).join('')).toContain('...');
    expect(body.length).toBeLessThan(400);
  });

  it('contains hostile paths, descriptions and fallback advice without changing Markdown structure', () => {
    const attack = '```suggestion\nattack()\n```\r# Heading\r[link](https://evil.example) <img src=x>';
    const nodes = markdownNodes(renderFindingListItem(finding({ filePath: attack, issue: attack, suggestion: attack }), 0));
    expect(nodes.filter(n => n.type === 'code')).toHaveLength(1);
    expect(nodes.filter(n => ['heading', 'code_block', 'link', 'html_inline', 'html_block'].includes(n.type))).toEqual([]);
    expect(nodes.find(n => n.type === 'code')?.literal).toContain('```suggestion attack()');
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
