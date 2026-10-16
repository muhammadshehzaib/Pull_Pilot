import { DiffFilterService } from '../../diff-filter.service';
import { collectChangedLines, AddedLine, RemovedLine } from '../../diff-lines';
import {
  SecurityProbeResult,
  SecuritySuggestion,
  MAX_FINDINGS_PER_RULE,
  checkForProbe,
  checkForProbeWithStatus,
} from '../probe-types';
import { advisoriesFor, isVulnerable, minSelectableVersion } from '../advisory-registry';
import { OsvClient, type OsvPackageRef, type OsvVulnerability } from '../osv-client';
import { SEVERITY_RANK } from '../../ai/finding-taxonomy';

/**
 * Dependency probe.
 *
 * Parses manifest lines from the *filtered diff* — package.json (tracking
 * dependency sections), requirements*.txt, go.mod, Gemfile — plus changed
 * lockfiles (package-lock.json, pnpm-lock.yaml, yarn.lock, go.sum,
 * Gemfile.lock, Cargo.lock, poetry.lock) and checks every package that was
 * actually introduced for known vulnerabilities.
 *
 * Two sources are consulted, in priority order:
 *   1. OSV.dev (https://osv.dev) — a live, aggregated advisory database. This
 *      is the real scanner; the probe does not pretend to maintain one.
 *   2. The bundled offline registry — a small strict upper-bound table used
 *      only when OSV is disabled or a *specific* package could not be looked
 *      up, so a network outage degrades coverage instead of silently dropping
 *      it.
 *
 * The probe is truthful about coverage:
 *   - No manifests or lockfiles changed -> a single SKIPPED check.
 *   - OSV query returned partial/no answers -> the DEPENDENCIES check is
 *     DEGRADED (the bundled registry filled the gaps); findings still fire.
 *   - A clean full run -> PASS. Findings -> FAIL.
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
 *
 * Output is bounded: at most MAX_LOCKFILES_PARSED lockfiles are read and at
 * most MAX_DEP_CANDIDATES enter the OSV query. Findings are deduplicated by
 * package/version/advisory so a manifest and its lockfile both resolving to
 * the same vulnerability do not double-count it.
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
  signal?: AbortSignal;
  /**
   * Optional unfiltered diff used only for lockfile parsing. Lockfiles are
   * excluded from AI review by default, but their exact resolved versions are
   * important for transitive dependency vulnerability checks.
   */
  lockfileDiff?: string;
}

/** Bounds that keep the probe cheap on very large diffs. */
const MAX_LOCKFILES_PARSED = 20;
const MAX_LOCKFILE_BYTES = 400_000;
const MAX_DEP_CANDIDATES = 500;

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

  // Manifest packages are queried with their minimum selectable version; the
  // candidate count stays bounded so a huge monorepo diff cannot balloon the
  // OSV request.
  const manifestCandidates = candidates.slice(0, MAX_DEP_CANDIDATES);

  // Lockfiles are deliberately excluded from the AI prompt by default, so
  // scan their added exact package versions separately. This catches
  // transitive packages and avoids sending large lockfile diffs to the model.
  const lockfileCandidates = parseLockfileDiff(options.lockfileDiff ?? diff);
  // Cap the combined set so the OSV query and findings stay bounded.
  const lockfileSlice = lockfileCandidates.slice(0, MAX_DEP_CANDIDATES);
  const allCandidates: DependencyCandidate[] = [...manifestCandidates, ...lockfileSlice];

  const scannedAnything = allCandidates.length > 0;

  // ── OSV lookup ────────────────────────────────────────────────────────────
  // Only packages whose constraint pins a queryable version are sent. A `*` or
  // `latest` spec offers nothing concrete to ask about; those fall back to the
  // bundled registry below.
  const osvByRef = new Map<string, OsvVulnerability[]>();
  const completeRefs = new Set<string>();
  let osvDegraded = false;

  if (options.osv && allCandidates.length > 0) {
    const refs: OsvPackageRef[] = [];
    const seenRefs = new Set<string>();
    for (const { dep, ecosystem } of allCandidates) {
      const version = osvVersionFor(dep.spec);
      if (!version) continue;
      const key = `${ecosystem}\u0000${dep.name}\u0000${version}`.toLowerCase();
      if (seenRefs.has(key)) continue;
      seenRefs.add(key);
      refs.push({ name: dep.name, version, ecosystem });
    }

    if (refs.length > 0) {
      const outcome = await options.osv.query(refs, options.signal);
      // Keep whatever OSV did answer authoritatively, and remember whether the
      // lookup was incomplete so the check can report DEGRADED rather than PASS.
      osvDegraded = outcome.degraded;
      for (const r of outcome.results) {
        const key = refKey(r.ref);
        if (r.complete) completeRefs.add(key);
        osvByRef.set(key, r.vulnerabilities);
      }
    }
  }

  const vulnerabilitiesFor = (dep: ManifestDependency, key: string): OsvVulnerability[] => {
    const live = osvByRef.get(key) ?? [];
    const fallback: OsvVulnerability[] = completeRefs.has(key) ? [] : advisoriesFor(dep.name)
      .filter(advisory => isVulnerable(dep.spec, advisory))
      .map(advisory => ({ id: 'bundled-registry', summary: advisory.description,
        severity: advisory.severity, severityKnown: true, aliases: [] }));
    // Strong offline evidence must not be hidden by incomplete live results or
    // lose its slot behind the per-rule findings cap.
    return [...live, ...fallback].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  };

  // ── Findings ──────────────────────────────────────────────────────────────
  // Dedupe across manifest and lockfile views of the same package: when both a
  // changed manifest range and its resolved lockfile version report the same
  // advisory, only the first (manifest, better-anchored) finding is kept.
  const seenFindings = new Set<string>();

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

      // Only a complete live lookup is authoritative. Partial live evidence
      // stays visible alongside any applicable bundled fallback evidence.
      let vulnerable = false;

      {
        const vulns = vulnerabilitiesFor(dep, key);
        for (const vuln of vulns) {
          if (!recordCount('deps-vulnerable')) break;
          const dedupeKey = `deps-vulnerable\u0000${ecosystem}\u0000${dep.name}\u0000${version}\u0000${vuln.id}`.toLowerCase();
          if (seenFindings.has(dedupeKey)) continue;
          seenFindings.add(dedupeKey);
          vulnerable = true;
          findings.push({
            filePath: filename,
            lineNumber: anchor.lineNumber,
            agentType: 'SECURITY',
            source: 'DEPENDENCIES',
            ruleKey: 'deps-vulnerable',
            issue: vuln.id === 'bundled-registry'
              ? `Introduced dependency "${dep.name}@${dep.spec}" has known vulnerabilities (${vuln.summary}).`
              : `Introduced dependency "${dep.name}@${dep.spec}" has a known vulnerability (${vuln.id}: ${vuln.summary})${severityNotice(vuln)}`,
            suggestion: vuln.id === 'bundled-registry' ? `Upgrade "${dep.name}" to a fixed release that satisfies the advisory.`
              : `Upgrade "${dep.name}" to a release that fixes ${vuln.id}.`,
            priority: vuln.severity,
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

  for (const { filename, dep, anchor, ecosystem } of lockfileSlice) {
    const version = osvVersionFor(dep.spec);
    if (!version) continue;
    const key = `${ecosystem}\u0000${dep.name}\u0000${version}`.toLowerCase();
    // OSV is authoritative for the packages it answered; anything it could not
    // be asked about falls back to the bundled registry.
    const vulns = vulnerabilitiesFor(dep, key);

    for (const vuln of vulns) {
      if (!recordCount('deps-vulnerable')) break;
      const dedupeKey = `deps-vulnerable\u0000${ecosystem}\u0000${dep.name}\u0000${version}\u0000${vuln.id}`.toLowerCase();
      if (seenFindings.has(dedupeKey)) continue;
      seenFindings.add(dedupeKey);
      findings.push({
        filePath: filename,
        lineNumber: anchor.lineNumber,
        agentType: 'SECURITY',
        source: 'DEPENDENCIES',
        ruleKey: 'deps-vulnerable',
        issue: `Resolved dependency "${dep.name}@${dep.spec}" has a known vulnerability (${vuln.id}: ${vuln.summary})${severityNotice(vuln)}`,
        suggestion: `Update the dependency tree so "${dep.name}" resolves to a release that fixes ${vuln.id}.`,
        priority: vuln.severity,
      });
    }
  }

  // ── Status ────────────────────────────────────────────────────────────────
  // The check is a *vulnerability* scan, so only `deps-vulnerable` findings
  // drive its status/count — the INFO "introduced" notes and LOW major-bump
  // notes stay in `findings` for the review body but must not mark the probe
  // FAIL. Never report a clean PASS for a run that had nothing to scan or only
  // partial advisory coverage.
  const ruleName = 'Vulnerable dependency scan';
  const vulnerableCount = findings.filter((f) => f.ruleKey === 'deps-vulnerable').length;

  if (!scannedAnything) {
    return {
      findings,
      checks: [
        checkForProbeWithStatus(
          'DEPENDENCIES',
          'dependencies',
          ruleName,
          'SKIPPED',
          0,
          'No supported manifests or lockfiles were changed in this diff.',
        ),
      ],
    };
  }

  if (vulnerableCount > 0) {
    // A finding wins over DEGRADED (checkForProbeWithStatus enforces the
    // priority), but the coverage caveat is still attached when relevant.
    return {
      findings,
      checks: [
        checkForProbeWithStatus(
          'DEPENDENCIES',
          'dependencies',
          ruleName,
          osvDegraded ? 'DEGRADED' : 'SKIPPED',
          vulnerableCount,
          osvDegraded
            ? 'Live OSV coverage is incomplete: some packages, advisory details or severities could not be confirmed. Bundled fallback evidence is included when available. Unconfirmed severities require manual review; findings may be incomplete.'
            : undefined,
        ),
      ],
    };
  }

  if (osvDegraded) {
    return {
      findings,
      checks: [
        checkForProbeWithStatus(
          'DEPENDENCIES',
          'dependencies',
          ruleName,
          'DEGRADED',
          0,
          'The live OSV database was unavailable for some packages; results fall back to the bundled offline registry and may be incomplete.',
        ),
      ],
    };
  }

  return {
    findings,
    checks: [checkForProbe('DEPENDENCIES', 'dependencies', ruleName, 0)],
  };
}

function severityNotice(vulnerability: OsvVulnerability): string {
  return vulnerability.severityKnown ? '' : ' Severity is unconfirmed; HIGH is a manual-review priority, not a confirmed database rating.';
}

// ── Lockfile parsing ──────────────────────────────────────────────────────

interface LockfileChunk {
  filename: string;
  /** Diff content for one lockfile, hunks intact. */
  content: string;
  bytes: number;
}

interface LockfileParser {
  file: RegExp;
  ecosystem: string;
  parse: (chunk: LockfileChunk) => DependencyCandidate[];
}

/**
 * Lockfile formats the probe understands. Each maps to the OSV ecosystem used
 * for the lookup. Adding a format is a matter of adding one parser here.
 */
const LOCKFILE_PARSERS: LockfileParser[] = [
  { file: /(?:^|\/)package-lock\.json$/i, ecosystem: 'npm', parse: parseNpmLockDiff },
  { file: /(?:^|\/)pnpm-lock\.ya?ml$/i, ecosystem: 'npm', parse: parsePnpmLockDiff },
  { file: /(?:^|\/)yarn\.lock$/i, ecosystem: 'npm', parse: parseYarnLockDiff },
  { file: /(?:^|\/)go\.sum$/i, ecosystem: 'Go', parse: parseGoSumDiff },
  { file: /(?:^|\/)Gemfile\.lock$/i, ecosystem: 'RubyGems', parse: parseGemfileLockDiff },
  { file: /(?:^|\/)Cargo\.lock$/i, ecosystem: 'crates.io', parse: (c) => parseNameVersionLock(c, 'crates.io') },
  { file: /(?:^|\/)poetry\.lock$/i, ecosystem: 'PyPI', parse: (c) => parseNameVersionLock(c, 'PyPI') },
];

function lockParserForFile(filename: string): LockfileParser | undefined {
  return LOCKFILE_PARSERS.find((p) => p.file.test(filename));
}

/**
 * Walks every changed lockfile chunk and dispatches to its parser. Bounded by
 * MAX_LOCKFILES_PARSED files and MAX_LOCKFILE_BYTES per file; lockfiles are
 * never sent to the model.
 */
function parseLockfileDiff(diff: string): DependencyCandidate[] {
  const candidates: DependencyCandidate[] = [];
  let parsedFiles = 0;
  for (const chunk of DiffFilterService.splitDiffByFile(diff)) {
    const parser = lockParserForFile(chunk.filename);
    if (!parser || parsedFiles >= MAX_LOCKFILES_PARSED) continue;
    const content = chunk.content.length > MAX_LOCKFILE_BYTES ? chunk.content.slice(0, MAX_LOCKFILE_BYTES) : chunk.content;
    candidates.push(...parser.parse({ filename: chunk.filename.replace(/^\.\//, ''), content, bytes: content.length }));
    parsedFiles += 1;
  }
  return candidates;
}

interface HunkLine {
  added: boolean;
  text: string;
  lineNumber: number;
}

/** Splits a per-file chunk into hunk lines with their new-file line number. */
function chunkHunkLines(content: string): HunkLine[] {
  const lines: HunkLine[] = [];
  let inHunk = false;
  let newLine = 0;
  for (const raw of content.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith('\\')) continue;
    const prefix = raw[0];
    if (prefix !== '+' && prefix !== '-' && prefix !== ' ') continue;
    lines.push({ added: prefix === '+', text: raw.slice(1), lineNumber: newLine });
    if (prefix !== '-') newLine += 1;
  }
  return lines;
}

function lockCandidate(filename: string, ecosystem: string, name: string, version: string, anchor: AddedLine): DependencyCandidate {
  return { filename, ecosystem, dep: { name, spec: version, dev: false, added: true }, anchor };
}

/** A pinned version — enough for OSV, unlike a range or a `link:` protocol. */
function isConcreteVersion(version: string): boolean {
  return /^\d+\.\d+/.test(version);
}

/**
 * package-lock.json v2/v3. The package key may be context (for a version-only
 * update), so track it across each hunk rather than requiring the key to be new.
 */
function parseNpmLockDiff(chunk: LockfileChunk): DependencyCandidate[] {
  const candidates: DependencyCandidate[] = [];
  const filename = chunk.filename;
  let inPackages = false;
  let packageName: string | null = null;

  for (const line of chunkHunkLines(chunk.content)) {
    const text = line.text;
    if (/^\s*"packages"\s*:\s*\{/.test(text)) inPackages = true;
    const packageKey = /^\s*"(node_modules\/.+)"\s*:\s*\{/.exec(text);
    if (inPackages && packageKey) packageName = npmNameFromLockPath(packageKey[1]);

    const version = /^\s*"version"\s*:\s*"(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)"/.exec(text);
    if (inPackages && line.added && packageName && version) {
      candidates.push(lockCandidate(filename, 'npm', packageName, version[1], lockAnchor(filename, line)));
    }
  }
  return candidates;
}

/**
 * pnpm-lock.yaml. Entries are keyed `name@version:` (v6 prefixes them with `/`,
 * v9 does not), so a newly added key line carries the exact resolved version.
 * A `version:` field is also handled for the two-line form.
 */
function parsePnpmLockDiff(chunk: LockfileChunk): DependencyCandidate[] {
  const candidates: DependencyCandidate[] = [];
  const filename = chunk.filename;
  let pending: { name: string; lineNumber: number } | null = null;

  for (const line of chunkHunkLines(chunk.content)) {
    const key = /^\s*\/?["']?((?:@[^@\s"']+\/)?[^@\s"':]+)@([^\s"':]+)["']?:\s*$/.exec(line.text);
    if (key) {
      pending = { name: key[1], lineNumber: line.lineNumber };
      if (line.added && isConcreteVersion(key[2])) {
        candidates.push(lockCandidate(filename, 'npm', key[1], key[2], lockAnchor(filename, line)));
      }
      continue;
    }
    const versionField = /^\s*version:\s*["']?([^\s"']+)["']?\s*$/.exec(line.text);
    if (versionField && pending && line.added && isConcreteVersion(versionField[1]) && line.lineNumber - pending.lineNumber <= 6) {
      candidates.push(lockCandidate(filename, 'npm', pending.name, versionField[1], lockAnchor(filename, line)));
    }
  }
  return candidates;
}

/**
 * yarn.lock (v1 classic and berry). A header line at column 0 (`name@range:`)
 * names the package; the introduced `version` line carries the resolution.
 */
function parseYarnLockDiff(chunk: LockfileChunk): DependencyCandidate[] {
  const candidates: DependencyCandidate[] = [];
  const filename = chunk.filename;
  let pending: { name: string; lineNumber: number } | null = null;

  for (const line of chunkHunkLines(chunk.content)) {
    const text = line.text;
    if (/^\S.*:\s*$/.test(text)) {
      const name = /^"?((?:@[^@/\s]+\/)?[^@\s]+?)(?:@|\s|:)/.exec(text.replace(/"/g, ''));
      pending = name ? { name: name[1], lineNumber: line.lineNumber } : null;
      continue;
    }
    const v1 = /^\s+version\s+"([^"]+)"/.exec(text);
    const berry = /^\s+version:\s*["']?([^\s"']+)["']?/.exec(text);
    const version = v1?.[1] ?? berry?.[1];
    if (version && pending && line.added && isConcreteVersion(version) && line.lineNumber - pending.lineNumber <= 6) {
      candidates.push(lockCandidate(filename, 'npm', pending.name, version, lockAnchor(filename, line)));
    }
  }
  return candidates;
}

/** go.sum. Each pinned module appears twice (zip hash + `go.mod` hash). */
function parseGoSumDiff(chunk: LockfileChunk): DependencyCandidate[] {
  const candidates: DependencyCandidate[] = [];
  const filename = chunk.filename;
  const seen = new Set<string>();

  for (const line of chunkHunkLines(chunk.content)) {
    if (!line.added) continue;
    const m = /^([^\s]+)\s+(v\d[^\s]*?)(?:\/go\.mod)?\s+h1:/.exec(line.text);
    if (!m) continue;
    const key = `${m[1]}\u0000${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(lockCandidate(filename, 'Go', m[1], m[2], lockAnchor(filename, line)));
  }
  return candidates;
}

/** Gemfile.lock. Resolved specs look like `    rake (13.0.1)` under `specs:`. */
function parseGemfileLockDiff(chunk: LockfileChunk): DependencyCandidate[] {
  const candidates: DependencyCandidate[] = [];
  const filename = chunk.filename;
  for (const line of chunkHunkLines(chunk.content)) {
    if (!line.added) continue;
    const m = /^\s{2,}([A-Za-z0-9_.-]+) \(([^)]+)\)\s*$/.exec(line.text);
    if (!m) continue;
    candidates.push(lockCandidate(filename, 'RubyGems', m[1], m[2], lockAnchor(filename, line)));
  }
  return candidates;
}

/** Cargo.lock / poetry.lock. `name = "x"` followed by an introduced `version =`. */
function parseNameVersionLock(chunk: LockfileChunk, ecosystem: string): DependencyCandidate[] {
  const candidates: DependencyCandidate[] = [];
  const filename = chunk.filename;
  let pending: string | null = null;

  for (const line of chunkHunkLines(chunk.content)) {
    const name = /^\s*name\s*=\s*"([^"]+)"/.exec(line.text);
    if (name) {
      pending = name[1];
      continue;
    }
    const version = /^\s*version\s*=\s*"([^"]+)"/.exec(line.text);
    if (version && pending && line.added && isConcreteVersion(version[1])) {
      candidates.push(lockCandidate(filename, ecosystem, pending, version[1], lockAnchor(filename, line)));
    }
  }
  return candidates;
}

function lockAnchor(filename: string, line: HunkLine): AddedLine {
  return { filename, lineNumber: line.lineNumber, text: line.text };
}

function npmNameFromLockPath(lockPath: string): string | null {
  const segments = lockPath.split('/');
  let marker = -1;
  for (let i = 0; i < segments.length; i += 1) {
    if (segments[i] === 'node_modules') marker = i;
  }
  if (marker < 0 || marker + 1 >= segments.length) return null;
  const first = segments[marker + 1];
  if (first.startsWith('@')) {
    const packageSegment = segments[marker + 2];
    return packageSegment ? `${first}/${packageSegment}` : null;
  }
  return first;
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
