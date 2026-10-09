import YAML from 'yaml';
import { GitHubService } from './github.service';
import { normalizeSeverity } from './ai/finding-taxonomy';
import { CONTEXT_MAX_FILES, CONTEXT_MAX_HOPS, CONTEXT_MAX_TOKENS } from '../utils/constants';

/**
 * Accepted values for `min_severity` in .aipr.yml, lowest to highest.
 * Case-insensitive; anything unrecognised falls back to the default.
 */
export const SEVERITY_LEVELS = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

/**
 * How much repository context a review pulls in.
 *
 * Every value is clamped to the platform ceiling in constants.ts. A
 * repository may turn context off or make it smaller, but cannot make it
 * larger than the platform allows — otherwise one config file could raise
 * token spend for everyone reviewing that repo.
 */
export interface ContextConfig {
  enabled: boolean;
  /** Neighbour files to gather. */
  max_files: number;
  /** Import distance to walk out from the change. */
  max_hops: number;
  /** Token ceiling for the context block, not counting the diff. */
  max_tokens: number;
}

/**
 * Deterministic security layer (SAST + secrets + dependency probes).
 *
 * Every probe runs on the filtered diff without any model judgement, so these
 * controls mirror `context`: a repository may narrow the scope but never
 * widen it beyond the defaults (there is nothing to clamp here, only booleans).
 */
export interface SecurityConfig {
  /** Master switch for the whole security layer. */
  enabled: boolean;
  /** Deterministic static-analysis probe (SQLi, XSS, SSRF, command injection…). */
  sast: boolean;
  /** Hardcoded credential / secret-key probe. */
  secrets: boolean;
  /** Introduced-dependency + known-vulnerability scan. */
  dependencies: boolean;
  /**
   * Consult the live OSV.dev advisory database for dependencies. When off (or
   * unreachable) the probe falls back to its bundled offline registry.
   */
  osv: boolean;
  /**
   * Run the external Semgrep scanner alongside the built-in SAST rules. Opt-in
   * because it requires the `semgrep` binary on the host; when unavailable the
   * pass is skipped and the built-in rules still run.
   */
  semgrep: boolean;
  /** A critical secret exposure raises the risk verdict to BLOCK. */
  block_on_critical_secret: boolean;
}

export interface AiPrConfig {
  version: number;
  ignore: string[];
  min_severity: SeverityLevel;
  guidelines: string[];
  language: string;
  summarize: boolean;
  context: ContextConfig;
  security: SecurityConfig;
}

export const DEFAULT_AIPR_CONFIG: AiPrConfig = {
  version: 1,
  ignore: [
    'dist/**',
    'build/**',
    'node_modules/**',
    '**/*.min.js',
    '**/*.min.css',
    '**/*.map',
    '**/*.lock',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    '**/*.svg',
    '**/*.png',
    '**/*.jpg',
    '**/*.jpeg',
  ],
  min_severity: 'low',
  guidelines: [],
  language: 'en',
  summarize: true,
  context: {
    enabled: true,
    max_files: CONTEXT_MAX_FILES,
    max_hops: CONTEXT_MAX_HOPS,
    max_tokens: CONTEXT_MAX_TOKENS,
  },
  security: {
    enabled: true,
    sast: true,
    secrets: true,
    dependencies: true,
    osv: true,
    semgrep: false,
    block_on_critical_secret: true,
  },
};

/**
 * Parses the optional `security:` block from .aipr.yml.
 *
 * Absent keys fall back to the defaults and non-boolean values are ignored,
 * mirroring parseContextConfig: a user-owned config file can turn scanners off
 * but cannot break the pipeline with a mistyped value.
 */
function parseSecurityConfig(raw: unknown): SecurityConfig {
  const defaults = DEFAULT_AIPR_CONFIG.security;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...defaults };

  const input = raw as Record<string, unknown>;
  const pick = (value: unknown): boolean | undefined =>
    typeof value === 'boolean' ? value : undefined;

  return {
    enabled: pick(input.enabled) ?? defaults.enabled,
    sast: pick(input.sast) ?? defaults.sast,
    secrets: pick(input.secrets) ?? defaults.secrets,
    dependencies: pick(input.dependencies) ?? defaults.dependencies,
    osv: pick(input.osv) ?? defaults.osv,
    semgrep: pick(input.semgrep) ?? defaults.semgrep,
    block_on_critical_secret: pick(input.block_on_critical_secret) ?? defaults.block_on_critical_secret,
  };
}

/**
 * Parses the optional `context:` block from .aipr.yml.
 *
 * Absent keys fall back to the platform defaults, and every numeric value is
 * clamped to its ceiling rather than trusted. A misconfiguration in a
 * user-owned file should degrade the context, never widen it.
 */
function parseContextConfig(raw: unknown): ContextConfig {
  const defaults = DEFAULT_AIPR_CONFIG.context;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...defaults };

  const input = raw as Record<string, unknown>;
  const fallback = { ...defaults };

  if (typeof input.enabled === 'boolean') fallback.enabled = input.enabled;

  const clamp = (value: unknown, ceiling: number): number | undefined => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    return Math.min(ceiling, Math.max(1, Math.floor(value)));
  };

  const files = clamp(input.max_files, CONTEXT_MAX_FILES);
  if (files !== undefined) fallback.max_files = files;

  const hops = clamp(input.max_hops, CONTEXT_MAX_HOPS);
  if (hops !== undefined) fallback.max_hops = hops;

  const tokens = clamp(input.max_tokens, CONTEXT_MAX_TOKENS);
  if (tokens !== undefined) fallback.max_tokens = tokens;

  return fallback;
}

const CONFIG_CANDIDATE_PATHS = [
  '.aipr.yml',
  '.aipr.yaml',
  '.github/.aipr.yml',
  '.github/.aipr.yaml',
];

export class ConfigService {
  /**
   * Parses a raw YAML string into a sanitized AiPrConfig object.
   */
  public static parseConfigYaml(yamlString: string): AiPrConfig {
    try {
      const parsed = YAML.parse(yamlString);
      if (!parsed || typeof parsed !== 'object') {
        return { ...DEFAULT_AIPR_CONFIG };
      }

      const ignore = Array.isArray(parsed.ignore)
        ? parsed.ignore.filter((item: any) => typeof item === 'string')
        : DEFAULT_AIPR_CONFIG.ignore;

      // Reuse the AI taxonomy so .aipr.yml and the model can never drift apart.
// Rejecting an unknown level silently is what previously made
// `min_severity: critical` a no-op, so warn when it happens.
      const rawSeverity = typeof parsed.min_severity === 'string' ? parsed.min_severity.trim() : '';
      const normalizedSeverity = normalizeSeverity(rawSeverity);
      let min_severity: SeverityLevel = DEFAULT_AIPR_CONFIG.min_severity;
      if (rawSeverity) {
        if (normalizedSeverity) {
          min_severity = normalizedSeverity.toLowerCase() as SeverityLevel;
        } else {
          console.warn(
            `⚠️ Unknown min_severity "${rawSeverity}" in .aipr.yml. ` +
            `Expected one of: ${SEVERITY_LEVELS.join(', ')}. Falling back to "${DEFAULT_AIPR_CONFIG.min_severity}".`,
          );
        }
      }

      const guidelines = Array.isArray(parsed.guidelines)
        ? parsed.guidelines.filter((item: any) => typeof item === 'string')
        : DEFAULT_AIPR_CONFIG.guidelines;

      const language = typeof parsed.language === 'string' ? parsed.language : DEFAULT_AIPR_CONFIG.language;
      const summarize = typeof parsed.summarize === 'boolean' ? parsed.summarize : DEFAULT_AIPR_CONFIG.summarize;
      const version = typeof parsed.version === 'number' ? parsed.version : DEFAULT_AIPR_CONFIG.version;
      const context = parseContextConfig(parsed.context);
      const security = parseSecurityConfig(parsed.security);

      return {
        version,
        ignore,
        min_severity,
        guidelines,
        language,
        summarize,
        context,
        security,
      };
    } catch (err) {
      console.warn('⚠️ Failed to parse .aipr.yml YAML content, falling back to default config:', (err as Error).message);
      return { ...DEFAULT_AIPR_CONFIG };
    }
  }

  /**
   * Fetches .aipr.yml (or candidate locations) from the target repository at a given ref.
   * If none exist, returns the default configuration.
   */
  public static async fetchRepoConfig(
    ghService: GitHubService,
    owner: string,
    repo: string,
    ref?: string
  ): Promise<AiPrConfig> {
    for (const configPath of CONFIG_CANDIDATE_PATHS) {
      try {
        const rawContent = await ghService.getFileContent(owner, repo, configPath, ref);
        if (rawContent) {
          console.log(`📄 Loaded repository config from: ${configPath} (${owner}/${repo})`);
          return this.parseConfigYaml(rawContent);
        }
      } catch {
        // Try next candidate
      }
    }

    // Default configuration if no config file is found
    return { ...DEFAULT_AIPR_CONFIG };
  }
}
