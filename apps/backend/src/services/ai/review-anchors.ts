import { createHash } from 'node:crypto';
import { collectAddedLines } from '../diff-lines';
import { DiffFilterService } from '../diff-filter.service';
import { normalizeSuggestions, type AiSuggestion } from './finding-taxonomy';

const ANCHOR = /^a1_[a-f0-9]{32}$/;
const safePath = (path: string) => path !== 'unknown' && path !== '/dev/null' && !path.startsWith('/') &&
  !/[\\\x00-\x1f]/.test(path) && !path.split('/').some(segment => segment === '..' || segment === '.');
const locationKey = (path: string, line: number) => JSON.stringify([path, line]);

export function reviewAnchors(diff: string) {
  const anchors = new Map<string, { id: string; filePath: string; lineNumber: number; text: string }>();
  const duplicates = new Set<string>();
  const locations = new Set<string>();
  for (const line of collectAddedLines(diff)) {
    if (!safePath(line.filename) || !Number.isSafeInteger(line.lineNumber) || line.lineNumber <= 0 ||
        line.lineNumber > 2147483647 || !line.text.trim()) continue;
    const key = locationKey(line.filename, line.lineNumber);
    if (locations.has(key)) duplicates.add(key);
    locations.add(key);
    const id = 'a1_' + createHash('sha256').update(JSON.stringify([line.filename, line.lineNumber, line.text])).digest('hex').slice(0, 32);
    anchors.set(id, { id, filePath: line.filename, lineNumber: line.lineNumber, text: line.text });
  }
  for (const [id, anchor] of anchors) if (duplicates.has(locationKey(anchor.filePath, anchor.lineNumber))) anchors.delete(id);
  return anchors;
}

/** Prompt-only labels. No copied source citation is kept in stored findings. */
export function labelledReviewDiff(diff: string) {
  const anchors = reviewAnchors(diff);
  const byLocation = new Map([...anchors.values()].map(a => [locationKey(a.filePath, a.lineNumber), a]));
  return DiffFilterService.splitDiffByFile(diff).map(chunk => {
    let oldLine = 0, newLine = 0, inHunk = false;
    return chunk.content.split('\n').map(line => {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; return line; }
      if (!inHunk || line.startsWith('\\')) return line;
      if (line.startsWith('+')) {
        const anchor = byLocation.get(locationKey(chunk.filename.replace(/^\.\//, ''), newLine));
        return `+ [new ${newLine++}${anchor ? ` anchor ${anchor.id}` : ''}] ${line.slice(1)}`;
      }
      if (line.startsWith('-')) return `- [old ${oldLine++}; no inline anchor] ${line.slice(1)}`;
      oldLine++;
      return `  [new ${newLine++}; context only] ${line.slice(1)}`;
    }).join('\n');
  }).join('\n\n');
}

/** Raw model fields are untrusted. A matching exact citation resolves the
 * authoritative coordinates; arbitrary supplied verifiedAnchor is ignored. */
export function normalizeAnchoredSuggestions(raw: unknown, diff: string): AiSuggestion[] {
  if (!Array.isArray(raw)) return [];
  const anchors = reviewAnchors(diff);
  return raw.flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const item = value as Record<string, unknown>;
    const anchor = typeof item.anchorId === 'string' ? anchors.get(item.anchorId) : undefined;
    const verified = anchor && typeof item.anchorText === 'string' && item.anchorText.length <= 4096 &&
      item.anchorText.trim() === anchor.text.trim();
    const finding = normalizeSuggestions([verified ? { ...item, filePath: anchor.filePath, lineNumber: anchor.lineNumber }
      : { ...item, filePath: typeof item.filePath === 'string' && item.filePath.trim() ? item.filePath : 'unknown' }])[0];
    if (!finding) return [];
    if (verified) finding.verifiedAnchor = anchor.id;
    return [finding];
  });
}

/** Independent delivery/pipeline guard; membership is required for every source. */
export function bindFindingAnchors(findings: AiSuggestion[], diff: string): AiSuggestion[] {
  const anchors = reviewAnchors(diff);
  const byLocation = new Map([...anchors.values()].map(a => [locationKey(a.filePath, a.lineNumber), a]));
  return findings.map(finding => {
    const { verifiedAnchor: _old, ...rest } = finding;
    const anchor = byLocation.get(locationKey(finding.filePath, finding.lineNumber));
    const deterministic = ['SAST', 'SECRETS', 'DEPENDENCIES', 'RULES'].includes(finding.source ?? 'LLM');
    return anchor && (deterministic || (ANCHOR.test(finding.verifiedAnchor ?? '') && finding.verifiedAnchor === anchor.id))
      ? { ...rest, verifiedAnchor: anchor.id } : rest;
  });
}
