import { DiffFilterService } from '../../diff-filter.service';
import { collectChangedLines, AddedLine, RemovedLine } from '../../diff-lines';
import {
  SecurityProbeResult,
  SecuritySuggestion,
  MAX_FINDINGS_PER_RULE,
  checkForProbe,
} from '../probe-types';
import { advisoriesFor, isVulnerable, minSelectableVersion } from '../advisory-registry';
import { OsvClient, type OsvPackageRef, type OsvVulnerability } from '../osv-client';
import { SEVERITY_RANK } from '../../ai/finding-taxonomy';

/**
 * Dependency probe.
 *
 * Parses manifest lines from the *filtered diff* — package.json (tracking
 * dependency sections), requirements*.txt, go.mod, Gemfile — and checks every
 * introduced package for known vulnerabilities. Lockfiles are excluded by the
 * default `ignore:` and are not parsed here.
 *
 * Two sources are consulted, in priority order:
 *   1. OSV.dev (https://osv.dev) — a live, aggregated advisory database. This
 *      is the real scanner; the probe does not pretend to maintain one.
 *   2. The bundled offline registry — a small strict upper-bound table used
 *      only when OSV is disabled or unreachable, so a network outage degrades
 *      coverage instead of silently dropping it.
 *
 * Because a manifest usually carries a range rather than a resolved version,
 * the OSV lookup asks about the *minimum selectable* version implied by the
 * constraint. If a resolution could legally land on a vulnerable release, the
 * finding fires — the same conservative stance the offline registry takes.
 *
 * Section headers inside package.json ("dependencies": {) are usually diff
 * *context*, not added lines, so the section stack is parsed from the whole
 * file chunk. Findings are only ever anchored to entries that were actually
 * *added* — a removed dependency never fires.
 */

interface ManifestDependency {
  name: string;
  spec: string;
  dev: boolean;
  /** True when this entry's own diff line was added (as opposed to removed). */
  added: boolean;
}

interface ParsedLine {
  text: string;
  added: boolean;
}

export interface DependencyScanOptions {
  /** When present, packages are looked up against the live OSV database. */
  osv?: OsvClient;
}

/** Splits a per-file chunk into cleaned content lines with their origin. */
function collectChunkLines(content: string): ParsedLine[] {
  const lines: ParsedLine[] = [];
  for (const raw of content.split('\n')) {
    if (/^diff --git/.test(raw)) continue;
    if (/^(---|\+\+\+) /.test(raw)) continue;
    if (/^@@ /.test(raw) || raw.startsWith('\\')) continue;
    let added = false;
    let text = raw;
    if (text.startsWith('+')) { added = true; text = text.slice(1); }
    else if (text.startsWith('-')) { text = text.slice(1); }
    text = text.trim();
    if (text.length === 0) continue;
    lines.push({ text, added });
  }
  return lines;
}

function parsePackageJson(lines: ParsedLine[]): ManifestDependency[] {
  const deps: ManifestDependency[] = [];
  let section: 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies' | null = null;

  for (const { text, added } of lines) {
    const sectionMatch = /^"((?:dev|peer|optional)?dependencies)"\s*:\s*\{/.exec(text);
    if (sectionMatch) {
      section = sectionMatch[1] as NonNullable<typeof section>;
      continue;
    }
    if (/^\}/.test(text)) {
      // Leave the section once its object closes; nesting depth is tracked
      // loosely since the manifest format is regular.
      section = null;
      continue;
    }
    const depMatch = /^"(@?[^"\s]+)"\s*:\s*"((?:\.{2}|~|\^|>=|=|<|>|v|latest|\d)[^"]*)",?\s*$/.exec(text);
    if (depMatch && section) {
      deps.push({ name: depMatch[1], spec: depMatch[2], dev: section === 'devDependencies', added });
    }
  }
  return deps;
}

function parseRequirements(lines: ParsedLine[]): ManifestDependency[] {
  const deps: ManifestDependency[] = [];
  for (const { text, added } of lines) {
    if (text.startsWith('#')) continue;
    // package==1.2.3, package>=1.0, package~=1.2, or a bare `package`.
    const m = /^([A-Za-z0-9_.-]+)\s*(==|>=|<=|~=|!=|>|<)?\s*([0-9][\w.+-]*)?/.exec(text);
    if (!m || !m[1]) continue;
    const name = m[1];
    if (!m[2] && text !== name) continue; // "from flask import x" is not a requirement
    deps.push({ name: name.toLowerCase(), spec: m[2] ? `${m[2]}${m[3] ?? ''}` : m[3] ?? '*', dev: false, added });
  }
  return deps;
}

function parseGoMod(lines: ParsedLine[]): ManifestDependency[] {
  const deps: ManifestDependency[] = [];
  let inRequire = false;
  for (const { text, added } of lines) {
    if (text === 'require (') { inRequire = true; continue; }
    if (text === ')') { inRequire = false; continue; }
    const m = /^require\s+([^\s]+)\s+(v\S+)/.exec(text);
    if (m) { deps.push({ name: m[1], spec: m[2], dev: false, added }); continue; }
    if (inRequire) {
      const m2 = /^([^\s]+)\s+(v\S+)/.exec(text);
      if (m2) deps.push({ name: m2[1], spec: m2[2], dev: false, added });
    }
  }
  return deps;
}

function parseGemfile(lines: ParsedLine[]): ManifestDependency[] {
  const deps: ManifestDependency[] = [];
  for (const { text, added } of lines) {
    if (text.startsWith('#')) continue;
    const m = /^gem\s+["']([^"']+)["']\s*(?:,\s*(["'][^"']+["']))?/.exec(text);
    if (!m) continue;
    const spec = m[2] ? m[2].replace(/["']/g, '') : '*';
    deps.push({ name: m[1].toLowerCase(), spec, dev: /github|path\s*:|group\s*:\s*:?dev/i.test(text), added });
  }
  return deps;
}

interface ManifestParser {
  file: RegExp;
  /** OSV ecosystem name for packages in this manifest. */
  ecosystem: string;
  parse: (lines: ParsedLine[]) => ManifestDependency[];
}

const MANIFEST_PARSERS: ManifestParser[] = [
  { file: /(?:^|\/)package\.json$/, ecosystem: 'npm', parse: parsePackageJson },
  { file: /requirements[^.]*\.txt$|requirements\.in$/, ecosystem: 'PyPI', parse: parseRequirements },
  { file: /(?:^|\/)go\.mod$/, ecosystem: 'Go', parse: parseGoMod },
  { file: /(?:^|\/)Gemfile$/, ecosystem: 'RubyGems', parse: parseGemfile },
];

function parserForFile(filename: string): ManifestParser | undefined {
  return MANIFEST_PARSERS.find((p) => p.file.test(filename));
}

interface DependencyCandidate {
  filename: string;
  dep: ManifestDependency;
  anchor: AddedLine;
  ecosystem: string;
}

/**
 * Scans changed manifest lines for known-vulnerable ranges and notes
 * newly introduced runtime dependencies.
 *
 * Async because the OSV lookup is a network call; the diff parsing itself is
 * synchronous and unchanged.
 */
export async function scanDependencies(
  diff: string,
  options: DependencyScanOptions = {},
): Promise<SecurityProbeResult> {
  const findings: SecuritySuggestion[] = [];
  const counts = new Map<string, number>();

  const recordCount = (key: string): boolean => {
    const n = counts.get(key) ?? 0;
    if (n >= MAX_FINDINGS_PER_RULE) return false;
    counts.set(key, n + 1);
    return true;
  };

  const { added: allAdded, removed: allRemoved } = collectChangedLines(diff);

  const addedByFile = new Map<string, AddedLine[]>();
  const removedByFile = new Map<string, RemovedLine[]>();
  for (const l of allAdded) {
    if (!addedByFile.has(l.filename)) addedByFile.set(l.filename, []);
    addedByFile.get(l.filename)!.push(l);
  }
  for (const l of allRemoved) {
    if (!removedByFile.has(l.filename)) removedByFile.set(l.filename, []);
    removedByFile.get(l.filename)!.push(l);
  }

  // Parse every changed manifest up front so the OSV lookup can batch across
  // files into a single request.
  const candidates: DependencyCandidate[] = [];
  const perFile = new Map<string, { parser: ManifestParser; deps: ManifestDependency[] }>();

  for (const chunk of DiffFilterService.splitDiffByFile(diff)) {
    const filename = chunk.filename.replace(/^\.\//, '');
    const parser = parserForFile(filename);
    if (!parser) continue;

    const addedLines = addedByFile.get(filename) ?? [];
    const removedLines = removedByFile.get(filename) ?? [];
    if (addedLines.length === 0 && removedLines.length === 0) continue;

    const parsed = collectChunkLines(chunk.content);
    const deps = parser.parse(parsed);
    if (deps.length === 0) continue;

    perFile.set(filename, { parser, deps });

    for (const dep of deps.filter((d) => d.added)) {
      const anchor = addedLines.find((l) => l.text.toLowerCase().includes(dep.name.toLowerCase()));
      if (!anchor) continue;
      candidates.push({ filename, dep, anchor, ecosystem: parser.ecosystem });
    }
  }

  // ── OSV lookup ────────────────────────────────────────────────────────────
  // Only packages whose constraint pins a queryable version are sent. A `*` or
  // `latest` spec offers nothing concrete to ask about; those fall back to the
  // bundled registry below.
  const osvByRef = new Map<string, OsvVulnerability[]>();
  const queriedRefs = new Set<string>();
  let osvActive = false;

  if (options.osv && candidates.length > 0) {
    const refs: OsvPackageRef[] = [];
    for (const { dep, ecosystem } of candidates) {
      const version = osvVersionFor(dep.spec);
      if (!version) continue;
      refs.push({ name: dep.name, version, ecosystem });
    }

    if (refs.length > 0) {
      const outcome = await options.osv.query(refs);
      if (!outcome.degraded) {
        osvActive = true;
        for (const r of outcome.results) {
          const key = refKey(r.ref);
          queriedRefs.add(key);
          osvByRef.set(key, r.vulnerabilities);
        }
      }
    }
  }

  // ── Findings ──────────────────────────────────────────────────────────────
  for (const [filename, { deps }] of perFile) {
    const addedLines = addedByFile.get(filename) ?? [];
    const removedByName = new Map<string, string>();
    for (const d of deps) {
      if (!d.added) removedByName.set(d.name.toLowerCase(), d.spec);
    }

    for (const dep of deps.filter((d) => d.added)) {
      const anchor = addedLines.find((l) => l.text.toLowerCase().includes(dep.name.toLowerCase()));
      if (!anchor) continue;

      const ecosystem = parserForFile(filename)?.ecosystem ?? '';
      const version = osvVersionFor(dep.spec);
      const key = version ? `${ecosystem}\u0000${dep.name}\u0000${version}`.toLowerCase() : '';

      // OSV is authoritative: if it answered for this package we trust it, and
      // never resurrect a stale offline entry it did not report. Only packages
      // OSV could not be asked about fall back to the bundled registry.
      const osvAnswerable = osvActive && version !== null && queriedRefs.has(key);
      let vulnerable = false;

      if (osvAnswerable) {
        const vulns = [...(osvByRef.get(key) ?? [])].sort(
          (a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0),
        );
        for (const vuln of vulns) {
          if (!recordCount('deps-vulnerable')) break;
          vulnerable = true;
          findings.push({
            filePath: filename,
            lineNumber: anchor.lineNumber,
            agentType: 'SECURITY',
            source: 'DEPENDENCIES',
            ruleKey: 'deps-vulnerable',
            issue: `Introduced dependency "${dep.name}@${dep.spec}" has a known vulnerability (${vuln.id}: ${vuln.summary})`,
            suggestion: `Upgrade "${dep.name}" to a release that fixes ${vuln.id}.`,
            priority: vuln.severity,
          });
        }
      } else {
        const advisories = advisoriesFor(dep.name).filter((a) => isVulnerable(dep.spec, a));
        if (advisories.length > 0 && recordCount('deps-vulnerable')) {
          vulnerable = true;
          const first = advisories[0];
          findings.push({
            filePath: filename,
            lineNumber: anchor.lineNumber,
            agentType: 'SECURITY',
            source: 'DEPENDENCIES',
            ruleKey: 'deps-vulnerable',
            issue: `Introduced dependency "${dep.name}@${dep.spec}" has known vulnerabilities (${first.description}).`,
            suggestion: `Upgrade "${dep.name}" to a fixed release that satisfies the advisory.`,
            priority: first.severity,
          });
        }
      }

      if (vulnerable) continue;

      if (recordCount('deps-introduced')) {
        findings.push({
          filePath: filename,
          lineNumber: anchor.lineNumber,
          agentType: 'SECURITY',
          source: 'DEPENDENCIES',
          ruleKey: 'deps-introduced',
          issue: `Dependency "${dep.name}" is being introduced (${dep.dev ? 'dev' : 'runtime'}).`,
          suggestion: dep.dev
            ? 'Dev-only dependency; safe to ignore if purely for tooling.'
            : 'Pin the version at a vetted release and add an SBOM entry so upgrades are reviewable.',
          priority: 'INFO',
        });
      }
    }

    if (recordCount('deps-major-bump')) {
      for (const dep of deps.filter((d) => d.added)) {
        const prior = removedByName.get(dep.name.toLowerCase());
        if (!prior) continue;
        const before = minSelectableVersion(prior);
        const after = minSelectableVersion(dep.spec);
        if (before && after && after.major > before.major) {
          const anchor = addedLines.find((l) => l.text.toLowerCase().includes(dep.name.toLowerCase()));
          findings.push({
            filePath: filename,
            lineNumber: anchor?.lineNumber ?? 1,
            agentType: 'SECURITY',
            source: 'DEPENDENCIES',
            ruleKey: 'deps-major-bump',
            issue: `Major version bump for "${dep.name}": ${prior} -> ${dep.spec}.`,
            suggestion: 'Review breaking changes in the new major before merging.',
            priority: 'LOW',
          });
          break;
        }
      }
    }
  }

  return {
    findings,
    checks: [checkForProbe('DEPENDENCIES', 'dependencies', 'Vulnerable dependency scan', findings.length)],
  };
}

/** The concrete version to ask OSV about, or null when the spec is a wildcard. */
function osvVersionFor(spec: string): string | null {
  const v = minSelectableVersion(spec);
  if (!v) return null;
  return `${v.major}.${v.minor}.${v.patch}`;
}

function refKey(ref: OsvPackageRef): string {
  return `${ref.ecosystem}\u0000${ref.name}\u0000${ref.version}`.toLowerCase();
}