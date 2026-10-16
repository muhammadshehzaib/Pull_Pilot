import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreate, AnthropicCtor } = vi.hoisted(() => {
  const mockCreate = vi.fn();
  const AnthropicCtor = vi.fn(function (this: any) {
    this.messages = { create: mockCreate };
  });
  return { mockCreate, AnthropicCtor };
});

vi.mock('@anthropic-ai/sdk', () => ({ default: AnthropicCtor }));

import { ClaudeProvider } from './claude.provider';

const sampleSuggestion = {
  filePath: 'src/foo.ts',
  lineNumber: 10,
  agentType: 'SECURITY',
  issue: 'SQL injection risk',
  suggestion: 'Use parameterized queries',
  priority: 'HIGH',
};

function makeResponse(text: string) {
  return { content: [{ type: 'text', text }] };
}

describe('ClaudeProvider', () => {
  let provider: ClaudeProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ClaudeProvider('sk-ant-test');
  });

  describe('constructor', () => {
    it('keeps historical summaries in the user context rather than system rules', async () => {
      mockCreate.mockResolvedValueOnce(makeResponse('[]'));
      await provider.analyzeCode('CURRENT_DIFF', [], undefined, { historicalContext: 'UNTRUSTED_HISTORY_PAYLOAD', feedbackContext: 'UNTRUSTED_FEEDBACK_STATS' });
      const request = mockCreate.mock.calls[0][0];
      expect(request.system).not.toContain('UNTRUSTED_HISTORY_PAYLOAD');
      expect(request.system).not.toContain('UNTRUSTED_FEEDBACK_STATS');
      expect(request.messages[0].content).toContain('UNTRUSTED_FEEDBACK_STATS');
      expect(request.messages[0].content).toContain('UNTRUSTED_HISTORY_PAYLOAD');
    });
    it('initializes the Anthropic client with the given API key', () => {
      new ClaudeProvider('sk-ant-abc');
      expect(AnthropicCtor).toHaveBeenCalledWith({ apiKey: 'sk-ant-abc', maxRetries: 0 });
    });
  });

  describe('analyzeCode() — happy path', () => {
    it('parses a clean JSON array response', async () => {
      mockCreate.mockResolvedValueOnce(makeResponse(JSON.stringify([sampleSuggestion])));

      const out = await provider.analyzeCode('diff --git ...');

      expect(out).toEqual([sampleSuggestion]);
    });

    it('returns an empty array when the model returns []', async () => {
      mockCreate.mockResolvedValueOnce(makeResponse('[]'));
      await expect(provider.analyzeCode('any diff')).resolves.toEqual([]);
    });

    it('passes the diff and the system prompt to Anthropic', async () => {
      mockCreate.mockResolvedValueOnce(makeResponse('[]'));
      await provider.analyzeCode('THE_DIFF_GOES_HERE');

      const call = mockCreate.mock.calls[0][0];
      expect(call.system).toMatch(/world-class software security/i);
      expect(call.messages[0].content).toContain('THE_DIFF_GOES_HERE');
      expect(call.max_tokens).toBeGreaterThan(0);
    });

    it('injects custom rules into the system prompt', async () => {
      mockCreate.mockResolvedValueOnce(makeResponse('[]'));
      await provider.analyzeCode('diff', ['No console.log allowed', 'Prefer async/await']);

      const call = mockCreate.mock.calls[0][0];
      expect(call.system).toContain('No console.log allowed');
      expect(call.system).toContain('Prefer async/await');
    });
  });

  describe('analyzeCode() — defensive parsing', () => {
    it('strips ```json code fences before parsing', async () => {
      const fenced = '```json\n' + JSON.stringify([sampleSuggestion]) + '\n```';
      mockCreate.mockResolvedValueOnce(makeResponse(fenced));

      const out = await provider.analyzeCode('diff');
      expect(out).toEqual([sampleSuggestion]);
    });

    it('strips plain ``` code fences (no json tag)', async () => {
      const fenced = '```\n' + JSON.stringify([sampleSuggestion]) + '\n```';
      mockCreate.mockResolvedValueOnce(makeResponse(fenced));

      await expect(provider.analyzeCode('diff')).resolves.toEqual([sampleSuggestion]);
    });

    it('unwraps a single-key object wrapper like { "suggestions": [...] }', async () => {
      mockCreate.mockResolvedValueOnce(
        makeResponse(JSON.stringify({ suggestions: [sampleSuggestion] })),
      );
      const out = await provider.analyzeCode('diff');
      expect(out).toEqual([sampleSuggestion]);
    });

    it('rejects a malformed wrapper instead of reporting a clean review', async () => {
      mockCreate.mockResolvedValueOnce(
        makeResponse(JSON.stringify({ note: 'no issues found' })),
      );
      await expect(provider.analyzeCode('diff')).rejects.toMatchObject({ reason: 'ai-invalid-response', retryable: false });
    });
  });

  describe('analyzeCode() — failure paths', () => {
    it('throws when the model returns invalid JSON', async () => {
      mockCreate.mockResolvedValueOnce(makeResponse('this is not json at all'));
      await expect(provider.analyzeCode('diff')).rejects.toThrow(/Claude API request failed/);
    });

    it('throws when the Anthropic SDK rejects (e.g., 401)', async () => {
      mockCreate.mockRejectedValueOnce(new Error('401 invalid x-api-key'));
      await expect(provider.analyzeCode('diff')).rejects.toThrow(/Claude API request failed/);
    });

    it('throws when the response has no text block at all', async () => {
      // .find(b => b.type === 'text') returns undefined -> raw becomes '' -> JSON.parse('') throws.
      mockCreate.mockResolvedValueOnce({ content: [{ type: 'tool_use' }] });
      await expect(provider.analyzeCode('diff')).rejects.toThrow(/Claude API request failed/);
    });
  });

  describe('analyzeCode() — additional edge cases', () => {
    it('picks the FIRST text block when the response has multiple content blocks', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: 'tool_use' },
          { type: 'text', text: JSON.stringify([sampleSuggestion]) },
          { type: 'text', text: 'IGNORED' },
        ],
      });
      await expect(provider.analyzeCode('diff')).resolves.toEqual([sampleSuggestion]);
    });

    it('handles a closing fence followed by trailing whitespace/newlines', async () => {
      // Opening fence is anchored at start; trailing whitespace after the closing fence
      // is tolerated by the second regex (/```\s*$/) plus the final .trim().
      const fenced = `\`\`\`json\n${JSON.stringify([sampleSuggestion])}\n\`\`\`\n\n   `;
      mockCreate.mockResolvedValueOnce(makeResponse(fenced));
      await expect(provider.analyzeCode('diff')).resolves.toEqual([sampleSuggestion]);
    });

    it('uses model name from CLAUDE_MODEL env (or a sane default starting with "claude")', async () => {
      mockCreate.mockResolvedValueOnce(makeResponse('[]'));
      await provider.analyzeCode('diff');
      const call = mockCreate.mock.calls[0][0];
      expect(call.model).toMatch(/^claude/);
    });

    it('sends a single user message (no chat history)', async () => {
      mockCreate.mockResolvedValueOnce(makeResponse('[]'));
      await provider.analyzeCode('diff');
      const call = mockCreate.mock.calls[0][0];
      expect(call.messages).toHaveLength(1);
      expect(call.messages[0].role).toBe('user');
    });

    it('does not include custom-rules section when rules array is empty', async () => {
      mockCreate.mockResolvedValueOnce(makeResponse('[]'));
      await provider.analyzeCode('diff', []);
      const call = mockCreate.mock.calls[0][0];
      expect(call.system).not.toContain('ADDITIONAL USER RULES TO ENFORCE');
    });

    it('extracts the named suggestions array alongside unrelated metadata', async () => {
      mockCreate.mockResolvedValueOnce(
        makeResponse(JSON.stringify({ suggestions: [sampleSuggestion], meta: 'unused' })),
      );
      await expect(provider.analyzeCode('diff')).resolves.toEqual([sampleSuggestion]);
    });

    it('logs to console.error on failure', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockCreate.mockRejectedValueOnce(new Error('boom'));
      await expect(provider.analyzeCode('diff')).rejects.toThrow();
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('passes max_tokens=8192 to bound responses with room for complete findings', async () => {
      mockCreate.mockResolvedValueOnce(makeResponse('[]'));
      await provider.analyzeCode('diff');
      const call = mockCreate.mock.calls[0][0];
      expect(call.max_tokens).toBe(8192);
    });
  });
});
