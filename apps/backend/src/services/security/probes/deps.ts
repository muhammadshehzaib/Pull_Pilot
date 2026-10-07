import { collectChangedLines } from '../../diff-lines';
import {
  SecurityProbeResult,
  SecuritySuggestion,
  MAX_FINDINGS_PER_RULE,
  checkForProbe,
} from '../probe-types';
import { advisoriesFor, isVulnerable, parseVersion } from '../advisory-registry';

/**
 * Dependency probe.
 *
 * Parses *added* manifest lines from the filtered diff — package.json
 * (tracking dependency sections), requirements*.txt, go.mod, Gemfile — then
 * checks every introduced package against the advisory registry. Also notes
 * newly introduced runtime dependencies (INFO) and detects removed-for-+
 * major-bump changes (LOW) as education. Lockfiles are excluded by the
 * default `ignore:` and are not parsed here.
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
    const depMatch = /^"(@?[^"\s]+)"\s*:\s*"(\.{2}|\^|~|>=|=|<|>|v|latest|\d)[^"]*"/.exec(line);
    if (depMatch && section) {
      deps.push({ name: depMatch[1], spec: depMatch[2], dev: section === 'devDependencies' });
    }
  }
  return deps;
}

function parseRequirements(lines: string[]): ManifestDependency[] {
  const deps: ManifestDependency[] = [];
  for (const raw of lines) {
    if (raw.trimStart().startsWith('#')) continue;
    // package==1.2.3, package>=1.0, package~=1.2, package (bare, no spec)
    const m = /^([A-Za-z0-9_.-]+)\s*(==|>=|<=|~=|!=|>|<)?\s*([0-9][\w.+-]*)?/.exec(raw);
    if (!m || !m[1]) continue;
    const name = m[1].toLowerCase();
    if (name.includes('.') && !m[2] && !m[3]) continue; // candidates without a spec look like filenames
    deps.push({ name, spec: m[2] ? `${m[2]}${m[3] ?? ''}` : m[3] ?? '*', dev: false });
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
    if (p.file.test(filename)) return p.parse(textLines.map((l) => l.trim()));
  }
  return [];
}

/**
 * Scans changed manifest lines for known-vulnerable ranges and notes
 * newly introduced runtime dependencies.
 */
export function scanDependencies(diff: string): SecurityProbeResult {
  const { added, removed } = collectChangedLines(diff);
  const findings: SecuritySuggestion[] = [];
  const counts = new Map<string, number>();

  const byFile = new Map<string, { added: typeof added; removed: typeof removed }>();
  for (const a of added) {
    if (!byFile.has(a.filename)) byFile.set(a.filename, { added: [], removed: [] });
    byFile.get(a.filename)!.added.push(a);
  }
  // Removed lines for major-bump detection: the diff parser numbers them with
  // the old-file position, which is fine for matching package names.
  for (const r of removed) {
    if (!byFile.has(r.filename)) byFile.set(r.filename, { added: [], removed: [] });
    byFile.get(r.filename)!.removed.push(r);
  }

  const recordCount = (key: string): boolean => {
    const n = counts.get(key) ?? 0;
    if (n >= MAX_FINDINGS_PER_RULE) return false;
    counts.set(key, n + 1);
    return true;
  };

  for (const [filename, { added: addedLines, removed: removedLines }] of byFile) {
    const fileRemovedTexts = removedLines.map((r) => r.text);
    const addedTexts = addedLines.map((a) => a.text);
    const deps = parseDependenciesForFile(filename, addedTexts);

    for (const dep of deps) {
      const advisories = advisoriesFor(dep.name).filter((a) => isVulnerable(dep.spec, a));
      if (advisories.length > 0 && recordCount('deps-vulnerable')) {
        const first = advisories[0];
        const anchor = addedLines.find((l) => {
          const t = l.text;
          return t.includes(`"${dep.name}"`) || t.includes(dep.name) || t.includes(`/${dep.name}/`);
        });
        findings.push({
          filePath: filename,
          lineNumber: anchor?.lineNumber ?? addedLines[0]?.lineNumber ?? 1,
          agentType: 'SECURITY',
          source: 'DEPENDENCIES',
          ruleKey: 'deps-vulnerable',
          issue: `Introduced dependency "${dep.name}@${dep.spec}" has known vulnerabilities (${first.description}).`,
          suggestion: `Upgrade "${dep.name}" to a fixed release that satisfies the advisory.`,
          priority: first.severity,
        });
        continue;
      }

      // Newly introduced package line: INFO-level education when no advisory.
      if (recordCount('deps-introduced') && /^[A-Za-z@]/.test(dep.name) && dep.name !== '(stdin)') {
        // Only comment on genuinely new packages — package.json "added" lines
        // are the package's own lines being touched, not the dep being added.
        const anchor = addedLines.find((l) => l.text.includes(`"${dep.name}"`) || l.text.includes(dep.name));
        if (!anchor) continue;
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

    // Removed -> added major bump: education note (LOW).
    if (recordCount('deps-major-bump')) {
      const removedDeps = parseDependenciesForFile(filename, fileRemovedTexts);
      const removedByName = new Map(removedDeps.map((d) => [d.name.toLowerCase(), d]));
      for (const dep of deps) {
        const prior = removedByName.get(dep.name.toLowerCase());
        if (!prior) continue;
        const before = parseVersion(prior.spec);
        const after = parseVersion(dep.spec);
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