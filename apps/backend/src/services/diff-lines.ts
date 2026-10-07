import { DiffFilterService } from './diff-filter.service';

export interface AddedLine {
  filename: string;
  lineNumber: number;
  text: string;
}

export interface RemovedLine {
  filename: string;
  lineNumber: number;
  text: string;
}

/** Splits added lines (new-file numbering) from removed lines (old-file numbering). */
export function collectChangedLines(diff: string): { added: AddedLine[]; removed: RemovedLine[] } {
  const added: AddedLine[] = [];
  const removed: RemovedLine[] = [];

  if (!diff || diff.trim().length === 0) return { added, removed };

  for (const chunk of DiffFilterService.splitDiffByFile(diff)) {
    const filename = chunk.filename.replace(/^\.\//, '');
    let newLine = 0;
    let oldLine = 0;
    let inHunk = false;

    for (const line of chunk.content.split('\n')) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        oldLine = parseInt(hunk[1], 10);
        newLine = parseInt(hunk[2], 10);
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;

      if (line.startsWith('+')) {
        added.push({ filename, lineNumber: newLine, text: line.slice(1) });
        newLine += 1;
      } else if (line.startsWith('-')) {
        removed.push({ filename, lineNumber: oldLine, text: line.slice(1) });
        oldLine += 1;
      } else if (line.startsWith('\\')) {
        // "\ No newline at end of file" advances nothing.
        continue;
      } else {
        oldLine += 1;
        newLine += 1;
      }
    }
  }
  return { added, removed };
}

/**
 * Extracts every added line from a unified diff with its new-file line
 * number, so a pattern match maps onto the exact line an inline comment
 * should target.
 *
 * Shared by the repository-rule engine and the deterministic security
 * probes: both only ever comment on lines that actually exist in the new
 * file, so a finding's `lineNumber` is always a valid anchor for GitHub's
 * review-comment API.
 */
export function collectAddedLines(diff: string): AddedLine[] {
  return collectChangedLines(diff).added;
}