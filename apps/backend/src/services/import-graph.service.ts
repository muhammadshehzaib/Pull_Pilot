import { CONTEXT_SOURCE_EXTENSIONS } from '../utils/constants';

/** A resolved import: the raw specifier plus the repo path it points at. */
export interface ResolvedImport {
  /** Exactly as written in source, e.g. '@/services/payment'. */
  specifier: string;
  /** Resolved repo-relative path, e.g. 'src/services/payment.ts'. Null when external. */
  resolvedPath: string | null;
  kind: ImportKind;
}

export type ImportKind = 'static' | 'dynamic' | 'export-from' | 'type-only' | 'require';

/**
 * Path aliases from tsconfig `paths` plus the baseUrl they resolve against.
 * Aliases are what make naive resolution wrong in real repos: `@/lib/x` is not
 * a package, and treating it as one loses every aliased edge.
 */
export interface PathAliases {
  baseUrl: string;
  /** Alias without the trailing `/*`, e.g. '@' or '@shared'. */
  entries: Array<{ prefix: string; targets: string[] }>;
}

/**
 * Extracts the import specifiers from a JS/TS source file.
 *
 * This is deliberately a lexer-style scan rather than a full parse. The goal is
 * to learn which files depend on which; getting that wrong is cheap (a missed
 * edge costs a little context) but a thrown parse error would cost a review. A
 * regex cannot understand strings, comments or templates, so the scan tracks
 * all three and only reports specifiers that appear in real code positions.
 */
export function extractImports(source: string): string[] {
  const specifiers: string[] = [];
  let i = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    // Line comment
    if (ch === '/' && next === '/') {
      i = source.indexOf('\n', i);
      if (i === -1) break;
      continue;
    }

    // Block comment
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }

    // String / template literal: skip so a path inside it is not read as code.
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(source, i);
      continue;
    }

    // import ... from 'x'  |  export ... from 'x'
    if ((ch === 'i' || ch === 'e') && source.startsWith('import', i) && isWordStart(source, i - 1)) {
      const consumed = readFromSpecifier(source, i + 6);
      if (consumed) {
        specifiers.push(consumed.specifier);
        i = consumed.next;
        continue;
      }
    }

    if (ch === 'e' && source.startsWith('export', i) && isWordStart(source, i - 1)) {
      const consumed = readFromSpecifier(source, i + 6);
      if (consumed) {
        specifiers.push(consumed.specifier);
        i = consumed.next;
        continue;
      }
    }

    // Bare side-effect import: import 'polyfill'
    if (ch === 'i' && source.startsWith('import', i) && isWordStart(source, i - 1)) {
      const rest = source.slice(i + 6);
      const quote = rest.search(/['"]/);
      if (quote !== -1 && /^\s*;?\s*$/.test(rest.slice(0, quote))) {
        const q = rest[quote];
        const end = rest.indexOf(q, quote + 1);
        if (end !== -1) {
          specifiers.push(rest.slice(quote + 1, end));
          i = i + 6 + end + 1;
          continue;
        }
      }
    }

    // Dynamic import( 'x' )
    if (ch === 'i' && source.startsWith('import', i) && isWordStart(source, i - 1)) {
      const after = source.slice(i + 6);
      const open = after.search(/\s*\(/);
      if (open !== -1) {
        const quoteAt = after.slice(open).search(/['"`]/);
        if (quoteAt !== -1) {
          const abs = i + 6 + open + quoteAt;
          const q = source[abs];
          const end = source.indexOf(q, abs + 1);
          if (end !== -1) {
            specifiers.push(source.slice(abs + 1, end));
            i = end + 1;
            continue;
          }
        }
      }
    }

    // require('x')
    if (ch === 'r' && source.startsWith('require', i) && isWordStart(source, i - 1)) {
      const after = source.slice(i + 7);
      const open = after.search(/\s*\(/);
      if (open !== -1) {
        const quoteAt = after.slice(open).search(/['"`]/);
        if (quoteAt !== -1) {
          const abs = i + 7 + open + quoteAt;
          const q = source[abs];
          const end = source.indexOf(q, abs + 1);
          if (end !== -1) {
            specifiers.push(source.slice(abs + 1, end));
            i = end + 1;
            continue;
          }
        }
      }
    }

    i++;
  }

  return specifiers;
}

/** True when the index at `at` is not part of a longer identifier. */
function isWordStart(source: string, at: number): boolean {
  if (at < 0) return true;
  const prev = source[at];
  return !/[A-Za-z0-9_$]/.test(prev);
}

/** Returns the index just past the closing quote of a string starting at `at`. */
function skipString(source: string, at: number): number {
  const quote = source[at];
  let i = at + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (quote === '`' && ch === '$' && source[i + 1] === '{') {
      // Template substitution can contain real code; treat it as skipped.
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (quote !== '`' && ch === '\n') return i;
    i++;
  }
  return source.length;
}

/**
 * Reads `from '<specifier>'` or `import '<specifier>'` starting at `at`
 * (just past the keyword). Returns null when the statement has no module.
 */
function readFromSpecifier(source: string, at: number): { specifier: string; next: number } | null {
  const rest = source.slice(at, at + 400);
  const fromIdx = rest.search(/\bfrom\b/);
  const semiIdx = rest.indexOf(';');

  if (fromIdx === -1) return null;
  if (semiIdx !== -1 && semiIdx < fromIdx) return null;

  const afterFrom = at + fromIdx + 4;
  const quoteAt = source.slice(afterFrom, afterFrom + 8).search(/['"]/);
  if (quoteAt === -1) return null;

  const q = source[afterFrom + quoteAt];
  const end = source.indexOf(q, afterFrom + quoteAt + 1);
  if (end === -1) return null;

  return { specifier: source.slice(afterFrom + quoteAt + 1, end), next: end + 1 };
}

/**
 * Resolves an import specifier to a repo-relative path.
 *
 * Handles the cases that actually appear in real repos, in the order a bundler
 * would try them:
 *   - explicit extension
 *   - implicit extension (.ts/.tsx/.js/...)
 *   - directory index (./x -> ./x/index.ts)
 *   - barrel-free path aliases from tsconfig
 *
 * Returns null for anything that is not an in-repo module (npm packages,
 * builtins, absolute URLs), because those have no file in the repository and
 * cannot contribute context.
 */
export function resolveImportSpecifier(
  specifier: string,
  fromFilePath: string,
  fileIndex: Map<string, string>,
  aliases: PathAliases | null = null,
): string | null {
  if (!specifier) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) return null; // http:, data:, node:

  const fromDir = dirnameOf(fromFilePath);

  let candidates: string[];
  if (specifier.startsWith('.')) {
    candidates = [joinPath(fromDir, specifier)];
  } else if (aliases) {
    // Aliases must be tried before treating a bare specifier as an npm package:
    // `@/services/x` looks exactly like a scoped package but is a repo path.
    candidates = aliasCandidates(specifier, aliases);
    if (candidates.length === 0) return null; // no alias matched → external
  } else {
    return null; // bare specifier with no aliases configured → npm package
  }

  for (const candidate of candidates) {
    const hit = lookup(candidate, fileIndex);
    if (hit) return hit;
  }

  return null;
}

/** True when the specifier names a package or builtin, not a repo file. */
function isExternal(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/');
}

/** Expands a tsconfig alias into the paths it could resolve to. */
function aliasCandidates(specifier: string, aliases: PathAliases): string[] {
  const out: string[] = [];

  for (const entry of aliases.entries) {
    if (!specifier.startsWith(entry.prefix)) continue;
    const rest = specifier.slice(entry.prefix.length).replace(/^\//, '');
    const wildcard = rest.includes('*') ? rest : null;

    for (const target of entry.targets) {
      const base = target.replace(/\*$/, '');
      if (wildcard !== null) {
        const star = wildcard.indexOf('*');
        out.push(joinPath(aliases.baseUrl, `${base}${wildcard.slice(0, star)}${wildcard.slice(star + 1)}`));
      } else {
        out.push(rest ? joinPath(aliases.baseUrl, `${base}${rest}`) : joinPath(aliases.baseUrl, base));
      }
    }
  }

  return out;
}

/** Tries a base path against every known resolution shape. */
function lookup(base: string, fileIndex: Map<string, string>): string | null {
  const clean = normalize(base);

  const exact = fileIndex.get(clean);
  if (exact) return exact;

  for (const ext of CONTEXT_SOURCE_EXTENSIONS) {
    const withExt = fileIndex.get(`${clean}${ext}`);
    if (withExt) return withExt;
  }

  for (const ext of CONTEXT_SOURCE_EXTENSIONS) {
    const asIndex = fileIndex.get(`${clean}/index${ext}`);
    if (asIndex) return asIndex;
  }

  // Some tsconfigs compile .ts away and import './x.js' for './x.ts'.
  for (const from of ['.js', '.mjs', '.cjs']) {
    if (!clean.endsWith(from)) continue;
    const stem = clean.slice(0, -from.length);
    for (const ext of ['.ts', '.tsx']) {
      const hit = fileIndex.get(`${stem}${ext}`);
      if (hit) return hit;
    }
  }

  return null;
}

/** Repo-relative join that keeps the result normalized. */
function joinPath(base: string, rel: string): string {
  if (rel.startsWith('/')) return normalize(rel);
  return normalize(`${base}/${rel}`);
}

/** Collapses `.` and `..` segments without touching the filesystem. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

/** Directory portion of a repo-relative path, '' at the root. */
function dirnameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

/**
 * Builds the lookup index for resolution. Only context candidates are indexed:
 * a specifier can only ever resolve to a file we would actually send.
 */
export function buildFileIndex(paths: Iterable<string>): Map<string, string> {
  const index = new Map<string, string>();
  for (const path of paths) {
    const clean = normalize(path);
    if (!index.has(clean)) index.set(clean, clean);
  }
  return index;
}

/**
 * Parses tsconfig `compilerOptions.paths` into alias prefixes.
 * Returns null when the project declares no aliases.
 */
export function parsePathAliases(
  tsconfig: unknown,
  repoPathOfTsconfig: string = '',
): PathAliases | null {
  if (!tsconfig || typeof tsconfig !== 'object') return null;
  const compilerOptions = (tsconfig as Record<string, unknown>).compilerOptions;
  if (!compilerOptions || typeof compilerOptions !== 'object') return null;

  const opts = compilerOptions as Record<string, unknown>;
  const baseUrl = typeof opts.baseUrl === 'string' ? opts.baseUrl : '.';
  const paths = opts.paths;
  if (!paths || typeof paths !== 'object') return null;

  const entries: Array<{ prefix: string; targets: string[] }> = [];
  for (const [key, value] of Object.entries(paths as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const targets = value.filter((t): t is string => typeof t === 'string');
    if (targets.length === 0) continue;
    // Longest prefix wins, so '@shared/*' beats '@/*' for the same specifier.
    entries.push({ prefix: key.replace(/\/\*$/, '').replace(/\*$/, ''), targets });
  }
  if (entries.length === 0) return null;

  entries.sort((a, b) => b.prefix.length - a.prefix.length);

  // baseUrl is relative to the tsconfig's own directory.
  const base = repoPathOfTsconfig ? dirnameOf(repoPathOfTsconfig) : '';
  const resolvedBase = base ? normalize(`${base}/${baseUrl}`) : normalize(baseUrl);

  return { baseUrl: resolvedBase, entries };
}