import { collectAddedLines } from '../diff-lines';

export const MAX_SCAN_DIFF_CHARS = 1000000;
export const MAX_SCAN_LINE_CHARS = 2048;
export const MAX_SCAN_LINES = 10000;
export const INCOMPLETE_SCAN = 'Scanner input exceeded size/line limits; omitted content was not checked.';

/** Never truncate a line into a plausible match; keep its line-number placeholder. */
export function boundScanInput(raw: string): { diff: string; incomplete: boolean } {
  let incomplete = raw.length > MAX_SCAN_DIFF_CHARS;
  let diff = raw;
  if (incomplete) {
    const end = raw.lastIndexOf('\n', MAX_SCAN_DIFF_CHARS);
    diff = end < 0 ? '' : raw.slice(0, end);
  }
  const lines = diff.split('\n');
  if (lines.length > MAX_SCAN_LINES) incomplete = true;
  const bounded = lines.slice(0, MAX_SCAN_LINES).map(line => {
    if (line.length <= MAX_SCAN_LINE_CHARS + 1) return line;
    incomplete = true;
    return ['+', '-', ' '].includes(line[0]) ? line[0] : '';
  });
  return { diff: bounded.join('\n'), incomplete };
}

export function boundedAddedLines(raw: string) {
  const input = boundScanInput(raw);
  return { lines: collectAddedLines(input.diff), incomplete: input.incomplete };
}
