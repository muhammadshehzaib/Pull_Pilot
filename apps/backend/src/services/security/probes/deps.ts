import { DiffFilterService } from '../../diff-filter.service';
import { collectChangedLines, AddedLine, RemovedLine } from '../../diff-lines';
import {
  SecurityProbeResult,
  SecuritySuggestion,
  MAX_FINDINGS_PER_RULE,
  checkForProbe,
} from '../probe-types';
import { advisoriesFor, isVulnerable, minSelectableVersion } from '../advisory-registry';

/**
 * Dependency probe.
 *
 * Parses manifest lines from the *filtered diff* — package.json (tracking
 * dependency sections), requirements*.txt, go.mod, Gemfile — then checks every
 * introduced package against the advisory registry. Also notes newly
 * introduced runtime dependencies (INFO) and detects removed-for-+
 * major-bump changes (LOW) as education. Lockfiles are excluded by the default
 * `ignore:` and are not parsed here.
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
}

function parsePackageJson(lines: string[]): ManifestDependency[] {
  const deps: ManifestDependency[] = [];
  let section: 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies' | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    const sectionMatch = /^"((?:dev|peer|optional)?dependencies)"\s*:\s*\{/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1] as NonNullable<typeof section>;
      continue;
    }
    if (/^\}/.test(line)) {
      // Leave the section once its object closes; nesting depth is tracked
      // loosely since the manifest format is regular.
      section = null;
      continue;
    }
    const depMatch = /^"(@?[^"\s]+)"\s*:\s*"((?:\.{2}|~|\^|>=|=|<|>|v|latest|\d)[^"]*)",?\s*$/.exec(line);
    if (depMatch && section) {
      deps.push({ name: depMatch[1], spec: depMatch[2], dev: section === 'devDependencies' });
    }
  }
  return deps;
}

function parseRequirements(lines: string[]): ManifestDependency[] {
  const deps: ManifestDependency[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    // package==1.2.3, package>=1.0, package~=1.2, or a bare `package`.
    const m = /^([A-Za-z0-9_.-]+)\s*(==|>=|<=|~=|!=|>|<)?\s*([0-9][\w.+-]*)?/.exec(line);
    if (!m || !m[1]) continue;
    const name = m[1];
    if (!m[2] && line !== name) continue; // "from flask import x" is not a requirement
    deps.push({ name: name.toLowerCase(), spec: m[2] ? `${m[2]}${m[3] ?? ''}` : m[3] ?? '*', dev: false });
  }
  return deps;
}

function parseGoMod(lines: string[]): ManifestDependency[] {
  const deps: ManifestDependency[] = [];
  let inRequire = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === 'require (') { inRequire = true; continue; }
    if (line === ')') { inRequire = false; continue; }
    const m = /^require\s+([^\s]+)\s+(v\S+)/.exec(line);
    if (m) { deps.push({ name: m[1], spec: m[2], dev: false }); continue; }
    if (inRequire) {
      const m2 = /^([^\s]+)\s+(v\S+)/.exec(line);
      if (m2) deps.push({ name: m2[1], spec: m2[2], dev: false });
    }
  }
  return deps;
}

function parseGemfile(lines: string[]): ManifestDependency[] {
  const deps: ManifestDependency[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    const m = /^gem\s+["']([^"']+)["']\s*(?:,\s*(["'][^"']+["']))?/.exec(line);
    if (!m) continue;
    const spec = m[2] ? m[2].replace(/["']/g, '') : '*';
    deps.push({ name: m[1].toLowerCase(), spec, dev: /github|path\s*:|group\s*:\s*:?dev/i.test(line) });
  }
  return deps;
}

const MANIFEST_PARSERS: { file: RegExp; parse: (lines: string[]) => ManifestDependency[] }[] = [
  { file: /(?:^|\/)package\.json$/, parse: parsePackageJson },
  { file: /requirements[^.]*\.txt$|requirements\.in$/, parse: parseRequirements },
  { file: /(?:^|\/)go\.mod$/, parse: parseGoMod },
  { file: /(?:^|\/)Gemfile$/, parse: parseGemfile },
];

function parseDependenciesForFile(filename: string, textLines: string[]): ManifestDependency[] {
  for (const p of MANIFEST_PARSERS) {
    if (p.file.test(filename)) return p.parse(textLines);
  }
  return [];
}

function isManifestFile(filename: string): boolean {
  return MANIFEST_PARSERS.some((p) => p.file.test(filename));
}

/**
 * Scans changed manifest lines for known-vulnerable ranges and notes
 * newly introduced runtime dependencies.
 */
export function scanDependencies(diff: string): SecurityProbeResult {
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

  for (const chunk of DiffFilterService.splitDiffByFile(diff)) {
    const filename = chunk.filename.replace(/^\.\//, '');
    if (!isManifestFile(filename)) continue;
    const addedLines = addedByFile.get(filename) ?? [];
    const removedLines = removedByFile.get(filename) ?? [];
    if (addedLines.length === 0 && removedLines.length === 0) continue;

    // Parse the whole chunk (context + added + removed) so section headers that
    // are diff context still drive the parser; entries are filtered back down
    // to added lines below, so removals can never be reported.
    const allTexts = chunk.content
      .split('\n')
      .map((t) => t.replace(/^[+-]/, '').trim())
      .filter((t) => t.length > 0 && !/^(diff --git|---|\+\+\+|@@|\\\\)/.test(t));

    const deps = parseDependenciesForFile(filename, allTexts as string[]);

    for (const dep of deps) {
      const anchor = addedLines.find(
        (l) => l.text.includes(`"${dep.name}"`) || l.text.includes(dep.name),
      );
      if (!anchor) continue;

      const advisories = advisoriesFor(dep.name).filter((a) => isVulnerable(dep.spec, a));
      if (advisories.length > 0 && recordCount('deps-vulnerable')) {
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
        continue;
      }

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
      const removedDeps = parseDependenciesForFile(
        filename,
        removedLines.map((r) => r.text.trim()),
      );
      const removedByName = new Map(removedDeps.map((d) => [d.name.toLowerCase(), d]));
      for (const dep of deps) {
        const prior = removedByName.get(dep.name.toLowerCase());
        if (!prior) continue;
        const before = minSelectableVersion(prior.spec);
        const after = minSelectableVersion(dep.spec);
        if (before && after && after.major > before.major) {
          const anchor = addedLines.find((l) => l.text.includes(dep.name));
          findings.push({
            filePath: filename,
            lineNumber: anchor?.lineNumber ?? 1,
            agentType: 'SECURITY',
            source: 'DEPENDENCIES',
            ruleKey: 'deps-major-bump',
            issue: `Major version bump for "${dep.name}": ${prior.spec} -> ${dep.spec}.`,
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