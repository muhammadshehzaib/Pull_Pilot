import { describe, it, expect, vi } from 'vitest';

// Stub the provider SDKs so their constructors don't try to validate keys / open clients.
vi.mock('openai', () => ({
  default: vi.fn(function (this: any) {
    this.chat = { completions: { create: vi.fn() } };
  }),
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(function (this: any) {
    this.messages = { create: vi.fn() };
  }),
}));
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn(function (this: any) {
    this.getGenerativeModel = vi.fn();
  }),
}));

import { AiProviderFactory } from './ai-factory';
import { ClaudeProvider } from './providers/claude.provider';
import { OpenAiProvider } from './providers/openai.provider';
import { GeminiProvider } from './providers/gemini.provider';
import { GrokProvider } from './providers/grok.provider';
import { BaseAiProvider } from './providers/base.provider';

describe('AiProviderFactory', () => {
  describe('getProvider() — happy path', () => {
    it('returns a ClaudeProvider for CLAUDE', () => {
      const p = AiProviderFactory.getProvider('CLAUDE' as any, 'sk-x');
      expect(p).toBeInstanceOf(ClaudeProvider);
      expect(p).toBeInstanceOf(BaseAiProvider);
    });

    it('returns an OpenAiProvider for OPENAI', () => {
      const p = AiProviderFactory.getProvider('OPENAI' as any, 'sk-x');
      expect(p).toBeInstanceOf(OpenAiProvider);
    });

    it('returns a GeminiProvider for GEMINI', () => {
      const p = AiProviderFactory.getProvider('GEMINI' as any, 'AIza-x');
      expect(p).toBeInstanceOf(GeminiProvider);
    });

    it('returns a GrokProvider for GROK', () => {
      const p = AiProviderFactory.getProvider('GROK' as any, 'xai-x');
      expect(p).toBeInstanceOf(GrokProvider);
    });

    it('returns a *new* instance every call (factory does not cache)', () => {
      const a = AiProviderFactory.getProvider('CLAUDE' as any, 'sk-x');
      const b = AiProviderFactory.getProvider('CLAUDE' as any, 'sk-x');
      expect(a).not.toBe(b);
    });
  });

  describe('getProvider() — breaking path', () => {
    it('rejects an empty vault key as a nonretryable authentication failure', () => {
      expect(() => AiProviderFactory.getProvider('CLAUDE', '  ')).toThrow(expect.objectContaining({ reason: 'ai-invalid-key', retryable: false }));
    });
    it('throws on an unknown provider type', () => {
      expect(() => AiProviderFactory.getProvider('PALANTIR' as any, 'x')).toThrow(
        /Unknown or unsupported AI Provider/,
      );
    });

    it('throws on undefined provider', () => {
      expect(() => AiProviderFactory.getProvider(undefined as any, 'x')).toThrow();
    });

    it('throws on lowercased provider name (enum is case-sensitive)', () => {
      expect(() => AiProviderFactory.getProvider('claude' as any, 'x')).toThrow();
    });
  });
});
