import { describe, it, expect } from 'vitest';
import { collectAddedLines, collectChangedLines } from './diff-lines';

function fileDiff(filename: string, added: string[], removed: string[] = []): string {
  const lines: string[] = [
    `diff --git a/${filename} b/${filename}`,
    `--- a/${filename}`,
    `+++ b/${filename}`,
    '@@ -1,1 +1,1 @@',
    ' context',
  ];
  for (const r of removed) lines.push(`-${r}`);
  for (const a of added) lines.push(`+${a}`);
  return lines.join('\n');
}

describe('collectAddedLines', () => {
  it('returns each added line with its new-file line number', () => {
    const diff = fileDiff('src/db.ts', ['const a = 1;', 'const b = 2;']);
    // context = 1, first added => 2, second => 3.
    expect(collectAddedLines(diff)).toEqual([
      { filename: 'src/db.ts', lineNumber: 2, text: 'const a = 1;' },
      { filename: 'src/db.ts', lineNumber: 3, text: 'const b = 2;' },
    ]);
  });

  it('strips the leading + and leaves removed lines alone', () => {
    const diff = fileDiff('a.py', ['x = 1'], ['DEAD = "line"']);
    expect(collectAddedLines(diff)).toEqual([{ filename: 'a.py', lineNumber: 2, text: 'x = 1' }]);
  });

  it('handles multi-file diffs by resetting numbering per file', () => {
    const diff =
      fileDiff('one.ts', ['x = 1']) +
      '\n' +
      fileDiff('two.ts', ['y = 2', 'z = 3']);
    const lines = collectAddedLines(diff);
    expect(lines).toEqual([
      { filename: 'one.ts', lineNumber: 2, text: 'x = 1' },
      { filename: 'two.ts', lineNumber: 2, text: 'y = 2' },
      { filename: 'two.ts', lineNumber: 3, text: 'z = 3' },
    ]);
  });

  it('returns an empty list for empty or non-diff input', () => {
    expect(collectAddedLines('')).toEqual([]);
    expect(collectAddedLines('   \n  ')).toEqual([]);
    expect(collectAddedLines('dev: crashed tonight')).toEqual([]);
  });
});

describe('collectChangedLines', () => {
  it('also returns removed lines with their old-file numbers', () => {
    const diff = fileDiff('pkg.json', ['"keep": true'], ['"gone": true']);
    const { added, removed } = collectChangedLines(diff);
    expect(added).toEqual([{ filename: 'pkg.json', lineNumber: 2, text: '"keep": true' }]);
    expect(removed).toEqual([{ filename: 'pkg.json', lineNumber: 2, text: '"gone": true' }]);
  });
});