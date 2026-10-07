import { FindingSeverity } from '../ai/finding-taxonomy';

/**
 * Seed advisory registry for the dependency probe.
 *
 * Each entry names a package and the version range that is known vulnerable,
 * answered as an upper bound (`lt`/`lte`). The probe compares the *minimum
 * selectable* version implied by the manifest's constraint against the bound:
 * if a resolution could legally pick a vulnerable version, the finding fires.
 * This is deliberately conservative — a strict upper-bound table, extended as
 * disclosures land — so it never relies on model judgement.
 */
export interface Advisory {
  package: string;
  /** Upper bound of the vulnerable set, inclusive/exclusive. */
  lt?: string;
  /** Inclusive upper bound; when set, versions at or below it are vulnerable. */
  lte?: string;
  /** Restrict to this major line (e.g. 2 for the node-fetch v2 advisories). */
  major?: number;
  severity: Exclude<FindingSeverity, 'INFO' | 'LOW'>;
  description: string;
}

export const ADVISORIES: Advisory[] = [
  { package: 'lodash', lt: '4.17.21', severity: 'HIGH', description: 'Prototype pollution and ReDoS, fixed in 4.17.21.' },
  { package: 'minimist', lte: '1.2.5', severity: 'HIGH', description: 'Prototype pollution via constructor prototype, patched in 1.2.6.' },
  { package: 'ajv', lt: '6.12.3', severity: 'MEDIUM', description: 'Prototype pollution via crafted schema, fixed in 6.12.3.' },
  { package: 'node-fetch', major: 2, lt: '2.6.7', severity: 'HIGH', description: 'Authorization-header leakage across redirects (CVE-2022-0235), fixed in 2.6.7.' },
  { package: 'node-fetch', major: 3, lt: '3.3.1', severity: 'HIGH', description: 'Exposure of sensitive information across redirects, fixed in 3.3.1.' },
  { package: 'express', lt: '4.17.3', severity: 'MEDIUM', description: 'Open redirect and qs parsing issues; upgrade to a supported 4.17.3+ release.' },
  { package: 'qs', lte: '6.2.3', severity: 'HIGH', description: 'Prototype pollution, fixed in 6.2.4+.' },
  { package: 'jsonwebtoken', lt: '9.0.2', severity: 'HIGH', description: 'Verification bypass / key confusion issues fixed in 9.0.2.' },
  { package: 'axios', lt: '0.21.2', severity: 'HIGH', description: 'Server-side request forgery (CVE-2021-3749); fixed in 0.21.2 / 0.22.0.' },
  { package: 'axios', major: 1, lt: '1.7.4', severity: 'HIGH', description: 'SSRF in form-data handling; upgrade to 1.7.4+.' },
  { package: 'path-to-regexp', major: 8, lt: '8.2.0', severity: 'CRITICAL', description: 'ReDoS and unexpected route matching (CVE-2025-46565); upgrade to 8.2.0+.' },
  { package: 'protobufjs', lt: '6.11.3', severity: 'MEDIUM', description: 'Prototype pollution, fixed in 6.11.3 / 7.2.2.' },
  { package: 'undici', lt: '5.28.4', severity: 'HIGH', description: 'Request smuggling / optimism bugs fixed in 5.28.4.' },
  { package: 'Pillow', lt: '9.0.1', severity: 'HIGH', description: 'Out-of-bounds read/write vulnerabilities; upgrade to 9.0.1+.' },
];

/** Advisory lookup by package name (case-insensitive). */
export function advisoriesFor(packageName: string): Advisory[] {
  const name = packageName.toLowerCase();
  return ADVISORIES.filter((a) => a.package.toLowerCase() === name);
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

const VERSION_RE = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:[-.+][0-9A-Za-z.-]+)?$/;

export function parseVersion(input: string): ParsedVersion | null {
  const m = VERSION_RE.exec(input.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0) };
}

function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Minimum *selectable* version implied by a manifest constraint spec.
 * Returns null when the constraint allows arbitrarily old versions
 * (`*`, `latest`, `<=x`) — which we treat as always potentially vulnerable.
 *
 *   "1.2.3"   -> 1.2.3   (exact)
 *   "^1.2.3"  -> 1.2.3   (caret pins to that minimum)
 *   "~1.2"    -> 1.2.0
 *   ">=0.5"   -> 0.5.0
 *   "1.x"     -> 1.0.0   (any 1.x could be selected)
 *   "<2.0"    -> < 2.0.0 (still within the bound, treated as 0.0.0-equivalent)
 */
export function minSelectableVersion(spec: string): ParsedVersion | null {
  const s = spec.trim().replace(/^[=]+/, '');
  const lowered = s.toLowerCase();

  if (lowered === '*' || lowered === 'latest' || lowered === 'x') return null;
  if (s.startsWith('<')) return null; // any version below the bound is selectable
  if (s.startsWith('>=') || s.startsWith('>')) {
    if (s.startsWith('>=')) return parseVersion(s.slice(2));
    return parseVersion(s.slice(1)); // treat `>x` min as x (best effort)
  }
  const clean = s.replace(/^[\^~]/, '').replace(/\.x$/i, '');
  // A bare major ("1", "1.x", "2") resolves into any patch of that major.
  if (!clean.includes('.')) {
    const major = Number(clean);
    if (!Number.isInteger(major) || major < 0) return null;
    return { major, minor: 0, patch: 0 };
  }
  const parsed = parseVersion(clean);
  if (!parsed) return null;
  return parsed;
}

export function isVulnerable(spec: string, advisory: Advisory): boolean {
  const min = minSelectableVersion(spec);
  if (advisory.major !== undefined) {
    if (!min) return true; // wildcards can legally resolve into the vulnerable major
    if (min.major !== advisory.major) return false;
  }

  if (advisory.lt) {
    const bound = parseVersion(advisory.lt);
    if (!bound) return false;
    if (min === null) return true;
    return compareVersions(min, bound) < 0;
  }
  if (advisory.lte) {
    const bound = parseVersion(advisory.lte);
    if (!bound) return false;
    if (min === null) return true;
    return compareVersions(min, bound) <= 0;
  }
  return false;
}