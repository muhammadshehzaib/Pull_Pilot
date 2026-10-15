import {
  AiSuggestion,
  FINDING_CATEGORIES,
  FINDING_SEVERITIES,
  FindingCategory,
  FindingSeverity,
} from './ai/finding-taxonomy';
import { collectAddedLines, AddedLine } from './diff-lines';
import { RE2 } from 're2-wasm';

export type RuleEnforcement = 'LLM' | 'DETERMINISTIC' | 'BOTH';
export type RuleCheckStatus = 'PASS' | 'FAIL' | 'SKIPPED';

const RULE_ENFORCEMENTS: readonly RuleEnforcement[] = ['LLM', 'DETERMINISTIC', 'BOTH'];

/** Field length caps. A rule is a prompt line, not an essay. */
const MAX_NAME = 120;
const MAX_DESCRIPTION = 500;
const MAX_GUIDELINE = 2000;
const MAX_PATTERN = 500;

/**
 * Violations reported per rule per review. A pattern like `\s+$` can match
 * nearly every added line; without a ceiling one bad rule would post hundreds
 * of inline comments on a single PR.
 */
const MAX_VIOLATIONS_PER_RULE = 50;

/** A validated rule, ready to persist. Nulls mean "not set for this enforcement". */
export interface RuleInput {
  name: string;
  description: string | null;
  guideline: string | null;
  pattern: string | null;
  severity: FindingSeverity;
  category: FindingCategory;
  enforcement: RuleEnforcement;
  enabled: boolean;
}

/** The subset of a stored rule the engine needs. */
export interface RuleRecord extends RuleInput {
  id: string;
}

export interface RuleCheckRecord {
  ruleId: string;
  ruleName: string;
  status: RuleCheckStatus;
  violationCount: number;
}

export interface RuleEvaluation {
  /** One pass/fail/skipped record per rule — the audit trail for this job. */
  checks: RuleCheckRecord[];
  /** Findings produced by deterministic rules, in diff order. */
  violations: AiSuggestion[];
}

type ValidationResult = { rule: RuleInput } | { error: string };

export class RulesService {
  /**
   * Validates and normalises a rule payload from the API.
   *
   * Cross-field rules follow the enforcement mode: an LLM rule must carry the
   * wording handed to the model, a DETERMINISTIC rule must carry a regular
   * expression that actually compiles, and BOTH must carry both. An invalid
   * pattern is rejected at write time so the worker never evaluates a rule it
   * cannot run.
   */
  public static validateRule(raw: unknown): ValidationResult {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: 'Rule body must be an object' };
    }
    const body = raw as Record<string, unknown>;

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return { error: 'name is required' };
    if (name.length > MAX_NAME) return { error: `name must be at most ${MAX_NAME} characters` };

    const description = readOptionalText(body.description, MAX_DESCRIPTION, 'description');
    if ('error' in description) return description;
    const guideline = readOptionalText(body.guideline, MAX_GUIDELINE, 'guideline');
    if ('error' in guideline) return guideline;
    const pattern = readOptionalText(body.pattern, MAX_PATTERN, 'pattern');
    if ('error' in pattern) return pattern;

    const enforcement = body.enforcement === undefined ? 'LLM' : body.enforcement;
    if (typeof enforcement !== 'string' || !RULE_ENFORCEMENTS.includes(enforcement as RuleEnforcement)) {
      return { error: `enforcement must be one of ${RULE_ENFORCEMENTS.join(', ')}` };
    }
    const mode = enforcement as RuleEnforcement;

    if ((mode === 'LLM' || mode === 'BOTH') && !guideline.value) {
      return { error: `guideline is required when enforcement is ${mode}` };
    }
    if (mode === 'DETERMINISTIC' || mode === 'BOTH') {
      if (!pattern.value) return { error: `pattern is required when enforcement is ${mode}` };
    }
    // Patterns are compiled whenever present — not only when the mode uses
    // them — so switching a rule to DETERMINISTIC later cannot activate an
    // expression that never worked.
    if (pattern.value) {
      const compiled = compilePattern(pattern.value);
      if (!compiled.ok) {
        return { error: `pattern is not a valid regular expression: ${compiled.error}` };
      }
    }

    const severity = body.severity === undefined ? 'MEDIUM' : body.severity;
    if (typeof severity !== 'string' || !FINDING_SEVERITIES.includes(severity as FindingSeverity)) {
      return { error: `severity must be one of ${FINDING_SEVERITIES.join(', ')}` };
    }

    const category = body.category === undefined ? 'MAINTAINABILITY' : body.category;
    if (typeof category !== 'string' || !FINDING_CATEGORIES.includes(category as FindingCategory)) {
      return { error: `category must be one of ${FINDING_CATEGORIES.join(', ')}` };
    }

    const enabled = body.enabled === undefined ? true : body.enabled;
    if (typeof enabled !== 'boolean') return { error: 'enabled must be a boolean' };

    return {
      rule: {
        name,
        description: description.value,
        guideline: guideline.value,
        pattern: pattern.value,
        severity: severity as FindingSeverity,
        category: category as FindingCategory,
        enforcement: mode,
        enabled,
      },
    };
  }

  /**
   * Merges stored rules into the guidelines loaded from .aipr.yml.
   *
   * Both sources land in the same `ADDITIONAL USER RULES TO ENFORCE` prompt
   * block, so the model sees one combined list. DETERMINISTIC-only rules are
   * excluded: their wording is a regex, which means nothing to a model.
   */
  public static mergeGuidelines(
    fileGuidelines: string[],
    rules: Array<Pick<RuleRecord, 'name' | 'guideline' | 'enforcement'>>,
  ): string[] {
    const fromRules = rules
      .filter((rule) => rule.guideline && (rule.enforcement === 'LLM' || rule.enforcement === 'BOTH'))
      .map((rule) => `[${rule.name}] ${rule.guideline}`);
    return [...fileGuidelines, ...fromRules];
  }

  /**
   * Evaluates every enabled rule against the diff.
   *
   * DETERMINISTIC and BOTH rules are checked by matching their pattern
   * against each *added* line — the same lines inline comments can be placed
   * on, so a violation always has a line to attach to. LLM-only rules produce
   * a SKIPPED record: pass/fail for those is the model's judgement, which is
   * recorded nowhere, so claiming PASS or FAIL would be a lie.
   */
  public static evaluateRules(rules: RuleRecord[], diff: string): RuleEvaluation {
    const checks: RuleCheckRecord[] = [];
    const violations: AiSuggestion[] = [];
    const deadline = Date.now() + 1000;

    const addedLines = rules.some((rule) => rule.enforcement !== 'LLM')
      ? collectAddedLines(diff)
      : [];

    for (const rule of rules) {
      if (rule.enforcement === 'LLM') {
        checks.push({ ruleId: rule.id, ruleName: rule.name, status: 'SKIPPED', violationCount: 0 });
        continue;
      }

      const compiled = compilePattern(rule.pattern ?? '');
      if (!compiled.ok) {
        // Unreachable through the API (patterns are validated at write time)
        // but a rule written directly into the DB must not crash the review.
        console.warn(`⚠️ Rule "${rule.name}" has an unusable pattern; skipping check:`, compiled.error);
        checks.push({ ruleId: rule.id, ruleName: rule.name, status: 'SKIPPED', violationCount: 0 });
        continue;
      }

      let count = 0;
      let incomplete = false;
      for (const line of addedLines) {
        if (Date.now() >= deadline) { incomplete = true; break; }
        if (count >= MAX_VIOLATIONS_PER_RULE) break;
        if (!compiled.regex.test(line.text)) continue;
        count += 1;
        violations.push(toViolation(rule, line));
      }
      if (count >= MAX_VIOLATIONS_PER_RULE) {
        console.warn(
          `⚠️ Rule "${rule.name}" hit the ${MAX_VIOLATIONS_PER_RULE}-violation ceiling; further matches in this review were not reported.`,
        );
      }

      checks.push({
        ruleId: rule.id,
        ruleName: rule.name,
        status: incomplete ? 'SKIPPED' : count > 0 ? 'FAIL' : 'PASS',
        violationCount: count,
      });
    }

    return { checks, violations };
  }
}

function readOptionalText(
  value: unknown,
  max: number,
  field: string,
): { value: string | null } | { error: string } {
  if (value === undefined || value === null || value === '') return { value: null };
  if (typeof value !== 'string') return { error: `${field} must be a string` };
  const trimmed = value.trim();
  if (!trimmed) return { value: null };
  if (trimmed.length > max) return { error: `${field} must be at most ${max} characters` };
  return { value: trimmed };
}

function compilePattern(pattern: string): { ok: true; regex: RE2 } | { ok: false; error: string } {
  try {
    if (pattern.length > MAX_PATTERN) return { ok: false, error: 'Pattern exceeds the execution limit.' };
    return { ok: true, regex: new RE2(pattern, 'u') };
  } catch {
    return { ok: false, error: 'Use supported RE2 syntax; backreferences and lookarounds are not supported.' };
  }
}

function toViolation(
  rule: RuleRecord,
  line: AddedLine,
): AiSuggestion {
  const explanation = rule.description ?? (rule.guideline ? rule.guideline : `matches \`${rule.pattern}\``);
  return {
    filePath: line.filename,
    lineNumber: line.lineNumber,
    agentType: rule.category,
    issue: `Violates repository rule "${rule.name}" — ${explanation}`,
    suggestion: `Update this line so it no longer violates the "${rule.name}" rule.`,
    priority: rule.severity,
    // Rules are a deterministic source, like the security probes — the risk
    // engine and UI use this to explain where a finding came from.
    source: 'RULES',
    ruleKeys: [rule.id],
  };
}
