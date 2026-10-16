import { describe, expect, it } from 'vitest';
import { reviewAnchors, labelledReviewDiff, normalizeAnchoredSuggestions, bindFindingAnchors } from './review-anchors';
import { normalizeStoredSuggestions, normalizeSuggestions } from './finding-taxonomy';
import { deduplicate } from './finding-dedup.service';

const diff = ['diff --git a/src/old.ts b/src/new.ts', 'similarity index 80%', 'rename from src/old.ts', 'rename to src/new.ts',
  '--- a/src/old.ts', '+++ b/src/new.ts', '@@ -10,3 +20,4 @@', ' context', '-oldValue()',
  '+const displayName = user.name;', '+console.log("Profile loaded");', ' tail',
  '@@ -50,1 +60,2 @@', '-gone()', '+other()', '+last()', '\\ No newline at end of file'].join('\n');
const sample = { filePath: 'src/new.ts', lineNumber: 21, agentType: 'BUG', priority: 'HIGH', issue: 'User can be null', suggestion: 'Guard user before reading its name' };
const anchors = [...reviewAnchors(diff).values()];
const anchor = anchors[0]!;

describe('server-generated review locations', () => {
  it('calculates new-file lines across deletions, context, multiple hunks and renames', () => {
    expect(anchors.map(a => [a.filePath, a.lineNumber])).toEqual([
      ['src/new.ts', 21], ['src/new.ts', 22], ['src/new.ts', 60], ['src/new.ts', 61],
    ]);
    expect(new Set(anchors.map(a => a.id)).size).toBe(4);
    const prompt = labelledReviewDiff(diff);
    expect(prompt).toContain(`[new 21 anchor ${anchor.id}] const displayName = user.name;`);
    expect(prompt).toContain('[old 11; no inline anchor] oldValue()');
    expect(prompt).toContain('[new 20; context only] context');
  });
  it('resolves matching evidence to real coordinates instead of trusting a neighbouring line number', () => {
    const findings = normalizeAnchoredSuggestions([{ ...sample, filePath: 'wrong.ts', lineNumber: 22,
      anchorId: anchor.id, anchorText: anchor.text }], diff);
    expect(findings).toEqual([{ ...sample, verifiedAnchor: anchor.id }]);
  });
  it('rejects the neighbouring label when its copied code does not match', () => {
    const findings = normalizeAnchoredSuggestions([{ ...sample, lineNumber: 22, anchorId: anchors[1]!.id, anchorText: anchor.text }], diff);
    expect(findings[0]).not.toHaveProperty('verifiedAnchor');
    expect(findings[0]!.issue).toBe(sample.issue);
  });
  it.each([undefined, 'a1_' + '0'.repeat(32), 'invented'])('keeps an unknown label %s out of inline findings', anchorId => {
    expect(normalizeAnchoredSuggestions([{ ...sample, anchorId, anchorText: anchor.text, verifiedAnchor: anchor.id }], diff)[0]).not.toHaveProperty('verifiedAnchor');
  });
  it('uses server labels only; a label-looking string inside code grants no authority', () => {
    const raw = `diff --git a/a.ts b/a.ts\n@@ -0,0 +1 @@\n+const text = "anchor a1_${'0'.repeat(32)}";`;
    const [finding] = normalizeAnchoredSuggestions([{ ...sample, anchorId: 'a1_' + '0'.repeat(32), anchorText: 'const text = "fake";' }], raw);
    expect(finding).not.toHaveProperty('verifiedAnchor');
  });
  it('never carries raw citations or model-provided trust metadata into stored findings', () => {
    const secret = 'private-source-value-that-must-not-be-persisted';
    const raw = `diff --git a/a.ts b/a.ts\n@@ -0,0 +1 @@\n+const API_TOKEN = "${secret}";`;
    const a = [...reviewAnchors(raw).values()][0]!;
    const findings = normalizeAnchoredSuggestions([{ ...sample, anchorId: a.id, anchorText: a.text,
      evidence: secret, location: { trusted: true } }], raw);
    const stored = JSON.stringify(normalizeStoredSuggestions(findings));
    expect(stored).not.toContain(secret); expect(stored).not.toContain('anchorText');
    expect(stored).not.toContain('evidence'); expect(stored).not.toContain('trusted');
    expect(findings[0]!.verifiedAnchor).toBe(a.id);
  });
  it('allows harmless indentation differences in the exact line citation', () => {
    expect(normalizeAnchoredSuggestions([{ ...sample, anchorId: anchor.id, anchorText: `  ${anchor.text}  ` }], diff)[0]!.verifiedAnchor).toBe(anchor.id);
  });
  it('does not guess coordinates for a partial code citation', () => {
    expect(normalizeAnchoredSuggestions([{ ...sample, anchorId: anchor.id, anchorText: 'user.name' }], diff)[0]).not.toHaveProperty('verifiedAnchor');
  });
  it('keeps a real finding with no reported file for the unverified summary', () => {
    expect(normalizeAnchoredSuggestions([{ ...sample, filePath: '', lineNumber: undefined }], diff)[0]).toEqual({ ...sample, filePath: 'unknown', lineNumber: 0 });
  });
  it('rejects ambiguous duplicate locations rather than picking one', () => {
    expect(reviewAnchors(diff + '\n' + diff).size).toBe(0);
  });
  it.each(['../../outside.ts', '/absolute.ts', 'unknown'])('does not authorize unsafe/unknown path %s', path => {
    expect(reviewAnchors(`diff --git a/${path} b/${path}\n@@ -0,0 +1 @@\n+code()`).size).toBe(0);
  });
  it('does not fabricate locations for unsupported quoted paths, removed-only diffs, or blank additions', () => {
    expect(reviewAnchors('diff --git "a/a\\t.ts" "b/a\\t.ts"\n@@ -0,0 +1 @@\n+code()').size).toBe(0);
    expect(reviewAnchors('diff --git a/a.ts b/a.ts\n@@ -1 +0,0 @@\n-gone()').size).toBe(0);
    expect(reviewAnchors('diff --git a/a.ts b/a.ts\n@@ -0,0 +1 @@\n+   ').size).toBe(0);
  });
  it('distinguishes the same source text in different files', () => {
    const raw = 'diff --git a/a.ts b/a.ts\n@@ -0,0 +1 @@\n+same()\ndiff --git a/b.ts b/b.ts\n@@ -0,0 +1 @@\n+same()';
    expect(new Set([...reviewAnchors(raw).keys()]).size).toBe(2);
  });
  it('checks label membership, path and line again before delivery', () => {
    const valid = normalizeAnchoredSuggestions([{ ...sample, anchorId: anchor.id, anchorText: anchor.text }], diff)[0]!;
    expect(bindFindingAnchors([valid], diff)[0]!.verifiedAnchor).toBe(anchor.id);
    expect(bindFindingAnchors([{ ...valid, lineNumber: 22 }], diff)[0]).not.toHaveProperty('verifiedAnchor');
    expect(bindFindingAnchors([{ ...valid, filePath: 'other.ts' }], diff)[0]).not.toHaveProperty('verifiedAnchor');
    expect(bindFindingAnchors([valid], diff.replace('user.name', 'user.id'))[0]).not.toHaveProperty('verifiedAnchor');
  });
  it('requires exact added-line membership for deterministic scanners too', () => {
    const finding = { ...sample, agentType: 'SECURITY' as const, priority: 'HIGH' as const, source: 'SAST' as const };
    expect(bindFindingAnchors([finding], diff)[0]!.verifiedAnchor).toBe(anchor.id);
    expect(bindFindingAnchors([{ ...finding, lineNumber: 20 }], diff)[0]).not.toHaveProperty('verifiedAnchor');
  });
  it('does not round a fractional line to its neighbour or accept forged verified metadata', () => {
    expect(normalizeSuggestions([{ ...sample, lineNumber: 21.9, verifiedAnchor: anchor.id }])[0]).toMatchObject({ lineNumber: 0 });
    expect(normalizeSuggestions([{ ...sample, verifiedAnchor: anchor.id }])[0]).not.toHaveProperty('verifiedAnchor');
  });
  it('keeps two verified nearby reports at their own code locations during deduplication', () => {
    const first = normalizeAnchoredSuggestions([{ ...sample, anchorId: anchor.id, anchorText: anchor.text }], diff)[0]!;
    const second = { ...first, lineNumber: 22, verifiedAnchor: anchors[1]!.id };
    expect(deduplicate([first, second])).toEqual([first, second]);
    expect(deduplicate([first, first])).toHaveLength(1);
    expect(deduplicate([first, first])[0]!.verifiedAnchor).toBe(first.verifiedAnchor);
  });
});
