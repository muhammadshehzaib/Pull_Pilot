import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { chat, claude, gemini } = vi.hoisted(() => ({ chat: vi.fn(), claude: vi.fn(), gemini: vi.fn() }));
vi.mock('openai', () => ({ default: class { chat = { completions: { create: chat } }; } }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: claude }; } }));
vi.mock('@google/generative-ai', () => ({ GoogleGenerativeAI: class { getGenerativeModel() { return { generateContent: gemini }; } } }));
import { OpenAiProvider } from './openai.provider';
import { ClaudeProvider } from './claude.provider';
import { GrokProvider } from './grok.provider';
import { GeminiProvider } from './gemini.provider';
import { reviewAnchors } from '../review-anchors';

const diff = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +21,2 @@\n-old()\n+const name = user.name;\n+log();';
const anchor = [...reviewAnchors(diff).values()][0]!;
const providers = { OpenAI: OpenAiProvider, Claude: ClaudeProvider, Grok: GrokProvider, Gemini: GeminiProvider };
type ProviderName = keyof typeof providers;
function respond(name: ProviderName, text: string) {
  if (name === 'Claude') claude.mockResolvedValueOnce({ content: [{ type: 'text', text }] });
  else if (name === 'Gemini') gemini.mockResolvedValueOnce({ response: { text: () => text } });
  else chat.mockResolvedValueOnce({ choices: [{ message: { content: text } }] });
}
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe.each(Object.keys(providers) as ProviderName[])('%s review location contract', name => {
  it('sends server labels and derives the real location from a matching code citation', async () => {
    respond(name, JSON.stringify([{ filePath: 'wrong-file.ts', lineNumber: 22, agentType: 'BUG', priority: 'HIGH',
      issue: 'Null access', suggestion: 'Guard the user', anchorId: anchor.id, anchorText: anchor.text }]));
    const provider = new providers[name]('test-api-key');
    const output = await provider.analyzeCode(diff);
    expect(output).toEqual([{ filePath: 'a.ts', lineNumber: 21, agentType: 'BUG', priority: 'HIGH',
      issue: 'Null access', suggestion: 'Guard the user', verifiedAnchor: anchor.id }]);
    const request = name === 'Claude' ? claude.mock.calls[0]![0] : name === 'Gemini' ? gemini.mock.calls[0]![0] : chat.mock.calls[0]![0];
    expect(JSON.stringify(request)).toContain(`[new 21 anchor ${anchor.id}]`);
    expect(JSON.stringify(output)).not.toContain('anchorText');
  });
  it('does not trust a valid neighbouring label with mismatched source evidence', async () => {
    const neighbour = [...reviewAnchors(diff).values()][1]!;
    respond(name, JSON.stringify([{ filePath: 'a.ts', lineNumber: 22, agentType: 'BUG', priority: 'HIGH',
      issue: 'Null access', suggestion: 'Guard the user', anchorId: neighbour.id, anchorText: anchor.text, verifiedAnchor: neighbour.id }]));
    const output = await new providers[name]('test-api-key').analyzeCode(diff);
    expect(output[0]).not.toHaveProperty('verifiedAnchor');
    expect(output).toHaveLength(1);
  });
  it('does not leak raw citations through malformed JSON errors or logs', async () => {
    const secret = 'source-private-value';
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    respond(name, `[{"anchorText":"${secret}","bad": broken}`);
    const error = await new providers[name]('test-api-key').analyzeCode(diff).catch(error => error as Error);
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain('invalid JSON');
    expect((error as Error).message).not.toContain(secret);
    expect(log.mock.calls.map(call => call.map(value => value instanceof Error ? value.message : value).join(' ')).join(' ')).not.toContain(secret);
  });
});
