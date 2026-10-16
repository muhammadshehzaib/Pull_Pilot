import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { chat, claude, gemini, chatCtor, claudeCtor, model } = vi.hoisted(() => {
  const chat = vi.fn(), claude = vi.fn(), gemini = vi.fn();
  const chatCtor = vi.fn(function (this: any) { this.chat = { completions: { create: chat } }; });
  const claudeCtor = vi.fn(function (this: any) { this.messages = { create: claude }; });
  const model = vi.fn(() => ({ generateContent: gemini }));
  return { chat, claude, gemini, chatCtor, claudeCtor, model };
});
vi.mock('openai', () => ({ default: chatCtor }));
vi.mock('@anthropic-ai/sdk', () => ({ default: claudeCtor }));
vi.mock('@google/generative-ai', () => ({ GoogleGenerativeAI: class { getGenerativeModel = model; } }));
import { OpenAiProvider } from './openai.provider';
import { ClaudeProvider } from './claude.provider';
import { GrokProvider } from './grok.provider';
import { GeminiProvider } from './gemini.provider';
import { MAX_AI_PROMPT_BYTES, MAX_AI_OUTPUT_TOKENS, MAX_REVIEW_DIFF_BYTES, MAX_AI_FINDINGS } from '../ai-request-policy';

const providers = { OpenAI: OpenAiProvider, Claude: ClaudeProvider, Grok: GrokProvider, Gemini: GeminiProvider };
type Name = keyof typeof providers;
const sdk = (name: Name) => name === 'Claude' ? claude : name === 'Gemini' ? gemini : chat;
function response(name: Name, text: string, truncated = false) {
  if (name === 'Claude') return { stop_reason: truncated ? 'max_tokens' : 'end_turn', content: [{ type: 'text', text }] };
  if (name === 'Gemini') return { response: { candidates: [{ finishReason: truncated ? 'MAX_TOKENS' : 'STOP' }], text: () => text } };
  return { choices: [{ finish_reason: truncated ? 'length' : 'stop', message: { content: text } }] };
}
beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

describe.each(Object.keys(providers) as Name[])('%s cost and retry policy', name => {
  it('uses one SDK attempt, a bounded output budget and a prioritized findings prompt', async () => {
    sdk(name).mockResolvedValueOnce(response(name, '[]'));
    await new providers[name]('test-key').analyzeCode('diff');
    const request = sdk(name).mock.calls[0]![0];
    if (name === 'Gemini') expect(model.mock.calls[0]![0].generationConfig.maxOutputTokens).toBe(MAX_AI_OUTPUT_TOKENS);
    else expect(request.max_tokens).toBe(MAX_AI_OUTPUT_TOKENS);
    if (name !== 'Gemini') expect((name === 'Claude' ? claudeCtor : chatCtor).mock.calls[0]![0].maxRetries).toBe(0);
    expect(JSON.stringify(request)).toContain(`at most ${MAX_AI_FINDINGS}`);
    expect(sdk(name)).toHaveBeenCalledOnce();
  });

  it.each(['review', 'auxiliary'] as const)('rejects a truncated %s response even if its partial JSON parses', async path => {
    sdk(name).mockResolvedValueOnce(response(name, '[]', true));
    const provider = new providers[name]('test-key');
    const result = path === 'review' ? provider.analyzeCode('diff')
      : (provider as any).completeJson({ systemPrompt: 'system', userPrompt: 'user' });
    await expect(result).rejects.toMatchObject({ reason: 'ai-response-truncated', retryable: false });
    expect(sdk(name)).toHaveBeenCalledOnce();
  });

  it.each(['review', 'auxiliary'] as const)('stops malformed %s JSON without leaking source text', async path => {
    sdk(name).mockResolvedValueOnce(response(name, '[{"anchorText":"private-source-value",broken}'));
    const provider = new providers[name]('test-key');
    const result = path === 'review' ? provider.analyzeCode('diff')
      : (provider as any).completeJson({ systemPrompt: 'system', userPrompt: 'user' });
    const error = await result.catch((error: Error) => error);
    expect(error).toMatchObject({ reason: 'ai-invalid-response', retryable: false });
    expect(error.message + JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('private-source-value');
    expect(sdk(name)).toHaveBeenCalledOnce();
  });

  it('rejects invalid credentials with a vault instruction and no raw SDK message', async () => {
    sdk(name).mockRejectedValueOnce(Object.assign(new Error('Authorization: private-api-key private-source'), { status: 401 }));
    const error = await new providers[name]('private-api-key').analyzeCode('diff').catch(error => error);
    expect(error).toMatchObject({ reason: 'ai-invalid-key', status: 401, retryable: false });
    expect(error.message).toContain('/vault');
    expect(error.message + JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('private-api-key');
    expect(sdk(name)).toHaveBeenCalledOnce();
  });

  it.each([429, 503])('preserves explicit transient status %s for the queue', async status => {
    sdk(name).mockRejectedValueOnce(Object.assign(new Error('upstream-private-data'), { status }));
    await expect(new providers[name]('test-key').analyzeCode('diff')).rejects.toMatchObject({ status, retryable: true });
    expect(sdk(name)).toHaveBeenCalledOnce();
  });

  it('rejects an oversized raw diff before calling the SDK', async () => {
    await expect(new providers[name]('test-key').analyzeCode('x'.repeat(MAX_REVIEW_DIFF_BYTES + 1)))
      .rejects.toMatchObject({ reason: 'ai-review-too-large', retryable: false });
    expect(sdk(name)).not.toHaveBeenCalled();
  });
  it('counts server labels in the prompt budget', async () => {
    const diff = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2000 @@\n' + '+x\n'.repeat(2000);
    expect(Buffer.byteLength(diff)).toBeLessThan(MAX_REVIEW_DIFF_BYTES);
    await expect(new providers[name]('test-key').analyzeCode(diff)).rejects.toMatchObject({ reason: 'ai-prompt-too-large', retryable: false });
    expect(sdk(name)).not.toHaveBeenCalled();
  });
  it.each(['review', 'auxiliary'] as const)('counts the full %s system/rules prompt before dispatch', async path => {
    const provider = new providers[name]('test-key');
    const oversized = '界'.repeat(Math.ceil(MAX_AI_PROMPT_BYTES / 3));
    const result = path === 'review' ? provider.analyzeCode('diff', [oversized])
      : (provider as any).completeJson({ systemPrompt: oversized, userPrompt: 'user' });
    await expect(result).rejects.toMatchObject({ reason: 'ai-prompt-too-large', retryable: false });
    expect(sdk(name)).not.toHaveBeenCalled();
  });
  it.each(['null', '{}', '{"suggestions": "not an array"}', ''])('does not publish invalid payload %j as a clean review', async text => {
    sdk(name).mockResolvedValueOnce(response(name, text));
    await expect(new providers[name]('test-key').analyzeCode('diff')).rejects.toMatchObject({ reason: 'ai-invalid-response', retryable: false });
  });
  it('rejects excessive findings without silently dropping reported problems', async () => {
    sdk(name).mockResolvedValueOnce(response(name, JSON.stringify(Array.from({ length: MAX_AI_FINDINGS + 1 }, () => ({})))));
    await expect(new providers[name]('test-key').analyzeCode('diff')).rejects.toMatchObject({ reason: 'ai-invalid-response', retryable: false });
    expect(sdk(name)).toHaveBeenCalledOnce();
  });
});
