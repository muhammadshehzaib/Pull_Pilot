import { describe, it, expect, vi } from 'vitest';
import { ConfigService, DEFAULT_AIPR_CONFIG, SEVERITY_LEVELS } from './config.service';

describe('ConfigService', () => {
  it('parses valid .aipr.yml string into AiPrConfig object', () => {
    const yamlString = `
version: 1
ignore:
  - "dist/**"
  - "build/**"
  - "**/*.test.ts"
min_severity: "high"
guidelines:
  - "Do not use any"
  - "Ensure 100% type safety"
language: "en"
summarize: true
`;

    const config = ConfigService.parseConfigYaml(yamlString);
    expect(config.version).toBe(1);
    expect(config.ignore).toEqual(['dist/**', 'build/**', '**/*.test.ts']);
    expect(config.min_severity).toBe('high');
    expect(config.guidelines).toHaveLength(2);
    expect(config.guidelines[0]).toBe('Do not use any');
    expect(config.summarize).toBe(true);
  });

  it('handles invalid or empty YAML gracefully by returning default config', () => {
    const config = ConfigService.parseConfigYaml('');
    expect(config).toEqual(DEFAULT_AIPR_CONFIG);
  });

  it('sanitizes invalid min_severity to default', () => {
    const yamlString = `
min_severity: "invalid_level"
`;
    const config = ConfigService.parseConfigYaml(yamlString);
    expect(config.min_severity).toBe('low');
  });

  it('accepts every documented severity level', () => {
    for (const level of SEVERITY_LEVELS) {
      const config = ConfigService.parseConfigYaml(`min_severity: "${level}"`);
      expect(config.min_severity).toBe(level);
    }
  });

  it('accepts severity levels in any casing', () => {
    expect(ConfigService.parseConfigYaml('min_severity: CRITICAL').min_severity).toBe('critical');
    expect(ConfigService.parseConfigYaml('min_severity: Info').min_severity).toBe('info');
  });

  it('warns when min_severity is unrecognised instead of failing silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = ConfigService.parseConfigYaml('min_severity: "urgent"');

    expect(config.min_severity).toBe('low');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('urgent'));
    warn.mockRestore();
  });

  it('does not warn when min_severity is omitted', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ConfigService.parseConfigYaml('version: 1');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('fetches repo config from GitHubService if present', async () => {
    const mockGhService: any = {
      getFileContent: vi.fn().mockImplementation(async (_owner, _repo, path) => {
        if (path === '.aipr.yml') {
          return 'min_severity: "critical"\nignore:\n  - "tests/**"';
        }
        return null;
      }),
    };

    const config = await ConfigService.fetchRepoConfig(mockGhService, 'owner', 'repo', 'main');
    expect(config.min_severity).toBe('critical');
    expect(config.ignore).toEqual(['tests/**']);
  });
});

describe('ConfigService context block', () => {
  it('enables context with platform defaults when the block is omitted', () => {
    expect(ConfigService.parseConfigYaml('version: 1').context).toEqual(
      DEFAULT_AIPR_CONFIG.context,
    );
  });

  it('accepts a repository turning context off', () => {
    const config = ConfigService.parseConfigYaml('context:\n  enabled: false');
    expect(config.context.enabled).toBe(false);
  });

  it('accepts a smaller context budget than the platform default', () => {
    const config = ConfigService.parseConfigYaml(
      'context:\n  max_files: 5\n  max_hops: 1\n  max_tokens: 8000',
    );
    expect(config.context.max_files).toBe(5);
    expect(config.context.max_hops).toBe(1);
    expect(config.context.max_tokens).toBe(8000);
  });

  it('clamps a context budget that exceeds the platform ceiling', () => {
    const config = ConfigService.parseConfigYaml(
      'context:\n  max_files: 100000\n  max_hops: 50\n  max_tokens: 10000000',
    );
    expect(config.context.max_files).toBe(DEFAULT_AIPR_CONFIG.context.max_files);
    expect(config.context.max_hops).toBe(DEFAULT_AIPR_CONFIG.context.max_hops);
    expect(config.context.max_tokens).toBe(DEFAULT_AIPR_CONFIG.context.max_tokens);
  });

  it('floors numeric budgets at 1 instead of accepting zero or negatives', () => {
    const config = ConfigService.parseConfigYaml(
      'context:\n  max_files: 0\n  max_hops: -4\n  max_tokens: -1',
    );
    expect(config.context.max_files).toBe(1);
    expect(config.context.max_hops).toBe(1);
    expect(config.context.max_tokens).toBe(1);
  });

  it('ignores non-numeric budget values rather than trusting them', () => {
    const config = ConfigService.parseConfigYaml(
      'context:\n  max_files: "lots"\n  max_hops: true\n  max_tokens: 1.9',
    );
    expect(config.context.max_files).toBe(DEFAULT_AIPR_CONFIG.context.max_files);
    expect(config.context.max_hops).toBe(DEFAULT_AIPR_CONFIG.context.max_hops);
    expect(config.context.max_tokens).toBe(1);
  });

  it('falls back to defaults when the context block is malformed', () => {
    const asArray = ConfigService.parseConfigYaml('context:\n  - a\n  - b');
    expect(asArray.context).toEqual(DEFAULT_AIPR_CONFIG.context);

    const asScalar = ConfigService.parseConfigYaml('context: "yes"');
    expect(asScalar.context).toEqual(DEFAULT_AIPR_CONFIG.context);
  });

  it('keeps unrelated keys working alongside a context block', () => {
    const config = ConfigService.parseConfigYaml(
      'min_severity: "high"\nsummarize: false\ncontext:\n  enabled: false',
    );
    expect(config.min_severity).toBe('high');
    expect(config.summarize).toBe(false);
    expect(config.context.enabled).toBe(false);
  });
});
