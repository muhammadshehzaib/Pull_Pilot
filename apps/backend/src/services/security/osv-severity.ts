import { CVSS } from '@turingpointde/cvss.js';
import { normalizeSeverity, SEVERITY_RANK, type FindingSeverity } from '../ai/finding-taxonomy';
import type { OsvPackageRef } from './osv-client';

export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Unknown is explicit; the caller applies manual-review policy, not MEDIUM. */
export function osvSeverity(raw: unknown, ref?: OsvPackageRef): FindingSeverity | null {
  if (!isRecord(raw)) return null;
  const scopes = [raw];
  let incomplete = Array.isArray(raw.affected) && raw.affected.length > 1000;
  if (Array.isArray(raw.affected)) for (const affected of raw.affected.slice(0, 1000)) {
    if (!isRecord(affected)) continue;
    const pkg = affected.package;
    if (ref && (!isRecord(pkg) || String(pkg.name).toLowerCase() !== ref.name.toLowerCase() ||
        String(pkg.ecosystem).toLowerCase() !== ref.ecosystem.toLowerCase())) continue;
    scopes.push(affected);
  }
  let strongest: FindingSeverity | null = null;
  const consider = (value: FindingSeverity | null) => {
    if (value && (!strongest || SEVERITY_RANK[value] > SEVERITY_RANK[strongest])) strongest = value;
  };
  for (const scope of scopes) {
    for (const field of ['database_specific', 'ecosystem_specific']) {
      const detail = scope[field];
      if (!isRecord(detail)) continue;
      consider(typeof detail.severity === 'string' && detail.severity.trim().toUpperCase() === 'NONE' ? 'INFO' : normalizeSeverity(detail.severity));
      if (strongest === 'CRITICAL') return 'CRITICAL';
      const score = numericScore(detail.cvss_score);
      if (score !== null) consider(severityFromScore(score));
      if (strongest === 'CRITICAL') return 'CRITICAL';
    }
    if (Array.isArray(scope.severity) && scope.severity.length > 16) incomplete = true;
    if (Array.isArray(scope.severity)) for (const entry of scope.severity.slice(0, 16)) {
      if (!isRecord(entry)) continue;
      if (!['CVSS_V2', 'CVSS_V3', 'CVSS_V4'].includes(String(entry.type))) continue;
      const score = numericScore(entry.score) ?? vectorScore(entry.type, entry.score);
      if (score !== null) consider(severityFromScore(score));
      if (strongest === 'CRITICAL') return 'CRITICAL';
    }
  }
  return strongest === 'CRITICAL' ? strongest : incomplete ? null : strongest;
}

function numericScore(value: unknown): number | null {
  if (typeof value === 'string') {
    if (value.length > 1024) return null;
    if (!/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
    value = Number(value);
  }
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10 ? value : null;
}

function vectorScore(type: unknown, value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 1024) return null;
  const vector = value.trim();
  try {
    if (type === 'CVSS_V2') return cvss2BaseScore(vector.replace(/^CVSS:2\.0\//, ''));
    const version = type === 'CVSS_V4' && vector.startsWith('CVSS:4.0/') ? '4.0'
      : type === 'CVSS_V3' && vector.startsWith('CVSS:3.1/') ? '3.1'
      : type === 'CVSS_V3' && vector.startsWith('CVSS:3.0/') ? '3.0' : null;
    if (!version) return null;
    const parts = vector.split('/').slice(1);
    if (new Set(parts.map(part => part.split(':')[0])).size !== parts.length || !CVSS(vector).isValid) return null;
    // Score intrinsic base metrics, not a lower temporal/environmental score.
    const base = version === '4.0' ? ['AV', 'AC', 'AT', 'PR', 'UI', 'VC', 'VI', 'VA', 'SC', 'SI', 'SA']
      : ['AV', 'AC', 'PR', 'UI', 'S', 'C', 'I', 'A'];
    return numericScore(CVSS(`CVSS:${version}/` + parts.filter(part => base.includes(part.split(':')[0]!)).join('/')).getScore());
  } catch { /* Malformed vectors are unknown; never invent a score. */ }
  return null;
}

/** FIRST CVSS v2 base equation: https://www.first.org/cvss/v2/guide#3-2-1-Base-Equation */
function cvss2BaseScore(vector: string): number | null {
  const weights: Record<string, Record<string, number>> = {
    AV: { L: 0.395, A: 0.646, N: 1 }, AC: { H: 0.35, M: 0.61, L: 0.71 }, Au: { M: 0.45, S: 0.56, N: 0.704 },
    C: { N: 0, P: 0.275, C: 0.66 }, I: { N: 0, P: 0.275, C: 0.66 }, A: { N: 0, P: 0.275, C: 0.66 },
  };
  const optional: Record<string, string[]> = { E: ['ND', 'U', 'POC', 'F', 'H'], RL: ['ND', 'OF', 'TF', 'W', 'U'],
    RC: ['ND', 'UC', 'UR', 'C'], CDP: ['ND', 'N', 'L', 'LM', 'MH', 'H'], TD: ['ND', 'N', 'L', 'M', 'H'],
    CR: ['ND', 'L', 'M', 'H'], IR: ['ND', 'L', 'M', 'H'], AR: ['ND', 'L', 'M', 'H'] };
  const metrics: Record<string, number> = {}, seen = new Set<string>();
  for (const part of vector.split('/')) {
    const [key, value, extra] = part.split(':');
    if (!key || !value || extra !== undefined || seen.has(key)) return null;
    seen.add(key);
    if (Object.hasOwn(weights, key) && Object.hasOwn(weights[key]!, value)) metrics[key] = weights[key]![value]!;
    else if (!Object.hasOwn(optional, key) || !optional[key]!.includes(value)) return null;
  }
  if (Object.keys(weights).some(key => !Object.hasOwn(metrics, key))) return null;
  const impact = 10.41 * (1 - (1 - metrics.C!) * (1 - metrics.I!) * (1 - metrics.A!));
  const exploitability = 20 * metrics.AV! * metrics.AC! * metrics.Au!;
  return impact === 0 ? 0 : Math.round(((0.6 * impact) + (0.4 * exploitability) - 1.5) * 1.176 * 10) / 10;
}

function severityFromScore(score: number): FindingSeverity {
  if (score >= 9) return 'CRITICAL';
  if (score >= 7) return 'HIGH';
  if (score >= 4) return 'MEDIUM';
  return score > 0 ? 'LOW' : 'INFO';
}
