import { beforeEach, describe, expect, it, vi } from 'vitest';
const { chat, claude, gemini } = vi.hoisted(() => ({ chat: vi.fn(), claude: vi.fn(), gemini: vi.fn() }));
vi.mock('openai', () => ({ default: class { chat = { completions: { create: chat } }; } }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: claude }; } }));
vi.mock('@google/generative-ai', () => ({ GoogleGenerativeAI: class { getGenerativeModel() { return { generateContent: gemini }; } } }));
import { OpenAiProvider } from './openai.provider';
import { GrokProvider } from './grok.provider';
import { ClaudeProvider } from './claude.provider';
import { GeminiProvider } from './gemini.provider';
import { tokenCount } from '../usage';
const diff = 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-export const n = 1;\n+export const n = 2;\n';
beforeEach(() => vi.clearAllMocks());
describe('provider usage accounting', () => {
  it.each([[OpenAiProvider, 'OPENAI'], [GrokProvider, 'GROK']] as const)('records actual response model and cache counts for %s', async (Provider, provider) => {
    chat.mockResolvedValue({ model: 'actual-model', choices: [{ finish_reason: 'stop', message: { content: '[]' } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } } });
    const onUsage = vi.fn();
    await expect(new Provider('test-key').analyzeCode(diff, [], undefined, { onUsage })).resolves.toEqual([]);
    expect(onUsage).toHaveBeenCalledWith({ provider, model: 'actual-model', inputTokens: 100, outputTokens: 20, cachedInputTokens: 30, cacheWriteTokens: 0 });
  });
  it('records paid usage before rejecting a truncated response', async () => {
    chat.mockResolvedValue({ model: 'actual', choices: [{ finish_reason: 'length', message: { content: '[' } }],
      usage: { prompt_tokens: 100, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 0 } } });
    const onUsage = vi.fn();
    await expect(new OpenAiProvider('test-key').analyzeCode(diff, [], undefined, { onUsage })).rejects.toBeDefined();
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ outputTokens: 500 }));
  });
  it('a failing observer does not retry or fail a successful paid review', async () => {
    chat.mockResolvedValue({ model: 'actual', choices: [{ finish_reason: 'stop', message: { content: '[]' } }] });
    await expect(new OpenAiProvider('test-key').analyzeCode(diff, [], undefined, { onUsage: () => { throw new Error('observer'); } })).resolves.toEqual([]);
    expect(chat).toHaveBeenCalledOnce();
  });
  it('adds cache read/write to Claude total input without dropping their separate counts', async () => {
    claude.mockResolvedValue({ model: 'claude-model', stop_reason: 'end_turn', content: [{ type: 'text', text: '[]' }],
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 } });
    const onUsage = vi.fn();
    await new ClaudeProvider('test-key').analyzeCode(diff, [], undefined, { onUsage });
    expect(onUsage).toHaveBeenCalledWith({ provider: 'CLAUDE', model: 'claude-model', inputTokens: 140, outputTokens: 20, cachedInputTokens: 30, cacheWriteTokens: 10 });
  });
  it('includes Gemini reasoning tokens in output via total minus input', async () => {
    gemini.mockResolvedValue({ response: { text: () => '[]', candidates: [{ finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 170, cachedContentTokenCount: 10 } } });
    const onUsage = vi.fn();
    await new GeminiProvider('test-key').analyzeCode(diff, [], undefined, { onUsage });
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 100, outputTokens: 70, cachedInputTokens: 10 }));
  });
  it('missing usage is unknown instead of zero', async () => {
    gemini.mockResolvedValue({ response: { text: () => '[]' } });
    const onUsage = vi.fn();
    await new GeminiProvider('test-key').analyzeCode(diff, [], undefined, { onUsage });
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: null, outputTokens: null, cachedInputTokens: null }));
    for (const value of [-1, NaN, Infinity, 1.5, undefined, '10']) expect(tokenCount(value)).toBeNull();
    expect(tokenCount(0)).toBe(0);
  });
});
