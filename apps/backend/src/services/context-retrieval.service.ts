import {
  extractImports,
  resolveImportSpecifier,
  buildFileIndex,
  parsePathAliases,
  type PathAliases,
} from './import-graph.service';
import { isTestPath, matchesRelated } from './test-gap/test-discovery.service';
import type { IndexedImports } from './repository-import-index.service';

/** A file selected as context, with why it was selected and where it sits. */
export interface ContextCandidate {
  path: string;
  /** Import distance from the nearest changed file. 0 means it changed. */
  hops: number;
  /** Why this file is relevant, in prompt-ready terms. */
  reasons: string[];
  /** Number of changed files that reach this file within the hop limit. */
  changedReach: number;
  /** How many repo files import this one. High values mean it is a hub. */
  inDegree: number;
  /** True when the file only re-exports other modules and holds no logic. */
  isBarrel: boolean;
  relation?: 'TEST' | 'CALLER' | 'DEPENDENCY' | 'TRANSITIVE' | 'LIKELY_TEST';
}

/** Inputs needed to walk out from the changed files. */
export interface NeighbourWalkInput {
  /** Repo-relative paths touched by the pull request. */
  changedPaths: string[];
  /** path -> source, for files whose content is already available. */
  contents: Map<string, string>;
  /** Every path in the repo, used to resolve specifiers. */
  allPaths: string[];
  /** Parsed tsconfig aliases, when the repo declares them. */
  aliases: PathAliases | null;
  maxHops: number;
  maxFiles: number;
  /** Imports from the inventory, independent of selected source bodies. */
  indexedImports?: Map<string, IndexedImports>;
}

export interface NeighbourWalkResult {
  candidates: ContextCandidate[];
  /** Neighbours found but dropped by maxFiles, nearest first. */
  dropped: ContextCandidate[];
  truncated: boolean;
}

/**
 * Selects the files worth showing the model alongside a diff.
 *
 * Two directions matter, and they are not the same. Walking *out* from the
 * change finds what the changed code depends on (the repository layer, the
 * schema it writes to). Walking *in* finds who depends on the change (the
 * webhook handler that also calls the modified function). A review that only
 * walks one direction misses half of what could go wrong, so both are built.
 *
 * Selection is deliberately bounded on three axes, because a real repository
 * graph is dense enough to be useless if followed literally:
 *  - `maxHops` limits distance, so a change deep in a package does not drag
 *    in half the monorepo;
 *  - `maxFiles` bounds cost, since every file is a fetch and prompt tokens;
 *  - hub and barrel demotion, because a file that most of the repo imports is
 *    context for none of them specifically and would otherwise win every
 *    ranking by sheer connectivity.
 *
 * Nothing here throws. A missing file or an unresolvable import costs a
 * little context; it must never cost the review itself.
 */
export function selectContextFiles(input: NeighbourWalkInput): NeighbourWalkResult {
  const { changedPaths, contents, allPaths, aliases, maxHops, maxFiles } = input;

  const fileIndex = buildFileIndex(allPaths);
  const changed = new Set(changedPaths.filter((p) => fileIndex.has(p)));

  // Indexed imports contribute edges even when the source body has not been
  // selected. Legacy callers can still provide a map of readable contents.
  const readable = allPaths.filter((p) => input.indexedImports ? input.indexedImports.has(p) : contents.has(p));

  const forward = new Map<string, string[]>(); // file -> files it imports
  const reverse = new Map<string, Set<string>>(); // file -> files importing it

  for (const path of readable) {
    const imports = new Set<string>();

    for (const specifier of input.indexedImports?.get(path)?.specifiers ?? extractImports(contents.get(path) ?? '')) {
      const resolved = resolveImportSpecifier(specifier, path, fileIndex, aliases);
      // A file importing itself is a cycle artefact, not a dependency.
      if (!resolved || resolved === path) continue;
      imports.add(resolved);
    }

    forward.set(path, [...imports]);
    for (const target of imports) {
      let importers = reverse.get(target);
      if (!importers) {
        importers = new Set();
        reverse.set(target, importers);
      }
      importers.add(path);
    }
  }

  const hops = walkBfs(changed, forward, reverse, maxHops);
  const nameMatched = new Set<string>();
  if (input.indexedImports && maxHops > 0) {
    const tests = allPaths.filter(isTestPath);
    // Name matching is weaker evidence. Keep it local to a package and pick
    // the closest two matches per affected source; never manufacture graph edges.
    for (const [source, hop] of [...hops]) {
      if (hop >= maxHops || isTestPath(source)) continue;
      const matches = tests.filter(test => !changed.has(test) && matchesRelated(source, test)
        && packageScope(source) === packageScope(test))
        .sort((a, b) => sharedDirectoryDepth(source, b) - sharedDirectoryDepth(source, a) || a.localeCompare(b)).slice(0, 2);
      for (const test of matches) {
        if (!hops.has(test)) { hops.set(test, hop + 1); nameMatched.add(test); }
      }
    }
  }

  const candidates: ContextCandidate[] = [];
  for (const [path, hop] of hops) {
    if (changed.has(path)) continue;
    candidates.push({
      path,
      hops: hop,
      reasons: nameMatched.has(path) ? ['likely related test by filename and package (coverage not verified)'] : describeRelations(path, changed, forward, reverse),
      changedReach: countChangedReach(path, changed, forward, reverse),
      inDegree: reverse.get(path)?.size ?? 0,
      isBarrel: input.indexedImports?.get(path)?.barrel ?? isBarrelFile(contents.get(path) ?? ''),
      relation: nameMatched.has(path) ? 'LIKELY_TEST' : isTestPath(path) ? 'TEST'
        : (forward.get(path) ?? []).some(target => changed.has(target)) ? 'CALLER'
        : [...(reverse.get(path) ?? [])].some(from => changed.has(from)) ? 'DEPENDENCY' : 'TRANSITIVE',
    });
  }

  const ranked = rankCandidates(candidates, maxFiles, Boolean(input.indexedImports));

  return {
    candidates: ranked.kept,
    dropped: ranked.dropped,
    truncated: ranked.dropped.length > 0,
  };
}

/**
 * Breadth-first distance from any changed file, following imports in both
 * directions. The first hop that reaches a path wins, so distance is the
 * shortest relevant distance rather than whichever traversal noticed first.
 */
function walkBfs(
  changed: Set<string>,
  forward: Map<string, string[]>,
  reverse: Map<string, Set<string>>,
  maxHops: number,
): Map<string, number> {
  const distance = new Map<string, number>();
  const queue: Array<{ path: string; hop: number }> = [];

  for (const path of changed) {
    distance.set(path, 0);
    queue.push({ path, hop: 0 });
  }

  while (queue.length > 0) {
    const { path, hop } = queue.shift()!;
    if (hop >= maxHops) continue;

    const neighbours = [...(forward.get(path) ?? []), ...(reverse.get(path) ?? [])];

    for (const next of neighbours) {
      if (distance.has(next)) continue;
      const nextHop = hop + 1;
      distance.set(next, nextHop);
      queue.push({ path: next, hop: nextHop });
    }
  }

  return distance;
}

/**
 * Explains, in prompt-ready language, why this file is being shown.
 *
 * The model uses this to judge relevance, so it needs to know the direction of
 * the relationship. "Payment calls this" and "this calls Payment" lead to
 * different observations about a change.
 */
function describeRelations(
  path: string,
  changed: Set<string>,
  forward: Map<string, string[]>,
  reverse: Map<string, Set<string>>,
): string[] {
  const reasons: string[] = [];

  const importers = [...(reverse.get(path) ?? [])].filter((p) => changed.has(p));
  if (importers.length > 0) {
    reasons.push(`imported by changed file(s): ${sortForPrompt(importers)}`);
  }

  const imported = [...(forward.get(path) ?? [])].filter((p) => changed.has(p));
  if (imported.length > 0) {
    reasons.push(`imports changed file(s): ${sortForPrompt(imported)}`);
  }

  // The file may sit between a changed file and its dependency.
  const importersAll = [...(reverse.get(path) ?? [])];
  if (importers.length === 0 && importersAll.length > 0) {
    reasons.push(`reachable from changed files (imported by ${sortForPrompt(importersAll.slice(0, 3))})`);
  }

  if (isTestLike(path)) {
    reasons.push('test file connected by imports (coverage not verified)');
  }

  if (reasons.length === 0) {
    reasons.push(`connected to changed files within the import graph`);
  }

  return reasons;
}

/**
 * How many changed files reach this file within a short walk.
 *
 * A file one hop from a single change is weaker evidence than a file two hops
 * from several changes, so this is the main signal for ranking. The walk is
 * bidirectional and capped in both depth and node count, because on a dense
 * graph an uncapped count is both expensive and meaningless.
 */
function countChangedReach(
  path: string,
  changed: Set<string>,
  forward: Map<string, string[]>,
  reverse: Map<string, Set<string>>,
): number {
  const seen = new Set<string>([path]);
  const queue: string[] = [path];
  let reach = 0;

  while (queue.length > 0 && seen.size < 400) {
    const current = queue.shift()!;
    if (current !== path && changed.has(current)) {
      reach += 1;
      // No need to walk past a changed file: everything beyond it is already
      // counted as reached from that file.
      continue;
    }
    for (const next of [...(forward.get(current) ?? []), ...(reverse.get(current) ?? [])]) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }

  return reach;
}

/**
 * Orders candidates and splits them into kept and dropped.
 *
 * Ranking prefers files that are close to the change and touched by more than
 * one changed file, then penalises hubs. A file imported by most of the repo
 * is real context but weak context; left uncorrected it wins every ranking
 * and crowds out the specific files that would let the model reason about the
 * change.
 */
function rankCandidates(
  candidates: ContextCandidate[],
  maxFiles: number,
  balance = false,
): { kept: ContextCandidate[]; dropped: ContextCandidate[] } {
  const sorted = [...candidates].sort((a, b) => {
    // A pure re-export barrel is ranked below real code at the same distance.
    // It imports everything, so on a dense repo it wins nearly every ranking on
    // connectivity alone while carrying none of the logic the model needs.
    if (a.isBarrel !== b.isBarrel) return a.isBarrel ? 1 : -1;
    if (a.hops !== b.hops) return a.hops - b.hops;
    if (b.changedReach !== a.changedReach) return b.changedReach - a.changedReach;
    // Hub penalty: prefer the less connected file when other signals tie.
    if (a.inDegree !== b.inDegree) return a.inDegree - b.inDegree;
    return a.path.localeCompare(b.path);
  });

  const kept: ContextCandidate[] = [];
  if (balance) {
    // Reserve useful representatives before redistributing remaining slots.
    for (const group of [['CALLER'], ['TEST', 'LIKELY_TEST'], ['DEPENDENCY']]) {
      if (kept.length >= maxFiles) break;
      const item = sorted.find(c => c.relation && group.includes(c.relation));
      if (item) kept.push(item);
    }
  }
  for (const item of sorted) if (kept.length < maxFiles && !kept.includes(item)) kept.push(item);
  return { kept, dropped: sorted.filter(item => !kept.includes(item)) };
}

function packageScope(path: string): string {
  const parts = path.split('/');
  return ['apps', 'packages'].includes(parts[0]) ? parts.slice(0, 2).join('/') : '';
}

function sharedDirectoryDepth(a: string, b: string): number {
  const left = a.split('/').slice(0, -1), right = b.split('/').slice(0, -1);
  let depth = 0;
  while (depth < left.length && left[depth] === right[depth]) depth++;
  return depth;
}

/**
 * True when a file only re-exports other modules.
 *
 * Barrels are common in real repos and they are poor context: they contain no
 * logic to review, yet their import lists make them look central. Detecting
 * them lets the ranking prefer the files that actually implement the change.
 *
 * Detection is deliberately conservative. It requires the file to have imports
 * and to have nothing left after imports, re-export statements, comments and
 * whitespace are removed, so a file with a single stray expression is not
 * mistaken for a barrel.
 */
export function isBarrelFile(source: string): boolean {
  let rest = source;

  // Comments, which are the usual content of a barrel header.
  rest = rest.replace(/\/\*[\s\S]*?\*\//g, '');
  rest = rest.replace(/\/\/[^\n]*/g, '');

  // import ... from 'x'  /  import 'x'
  rest = rest.replace(/import\s+[\s\S]*?from\s*['"][^'"]*['"]\s*;?/g, '');
  rest = rest.replace(/import\s+['"][^'"]*['"]\s*;?/g, '');

  // require('x')
  rest = rest.replace(/require\s*\(\s*['"][^'"]*['"]\s*\)\s*;?/g, '');

  // export { a } from 'x'  /  export * from 'x'  /  export * as ns from 'x'
  rest = rest.replace(/export\s+[\s\S]*?from\s*['"][^'"]*['"]\s*;?/g, '');

  // export type { T } from 'x' is covered above; handle a bare `export {}`.
  rest = rest.replace(/export\s*\{[^}]*\}\s*;?/g, '');

  // Anything left that is not punctuation means real code.
  return rest.replace(/[\s;,]/g, '') === '';
}

/** True for paths that look like tests, which are strong context when present. */
function isTestLike(path: string): boolean {
  return isTestPath(path);
}

/** Joins paths for a prompt, capped so one file cannot flood a reason. */
function sortForPrompt(paths: string[]): string {
  const sorted = [...paths].sort();
  const shown = sorted.slice(0, 4);
  const suffix = sorted.length > shown.length ? ` (+${sorted.length - shown.length} more)` : '';
  return shown.join(', ') + suffix;
}
