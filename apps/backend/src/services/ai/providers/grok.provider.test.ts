import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreate, OpenAICtor } = vi.hoisted(() => {
  // Prisma generation can load local provider overrides. Unit fixtures must be explicit.
  vi.stubEnv('GROK_BASE_URL', 'https://api.x.ai/v1');
  vi.stubEnv('GROK_MODEL', 'grok-2-latest');
  const mockCreate = vi.fn();
  const OpenAICtor = vi.fn(function (this: any, opts?: { apiKey: string; baseURL?: string }) {
    (this as any)._opts = opts;
    this.chat = { completions: { create: mockCreate } };
  });
  return { mockCreate, OpenAICtor };
});

vi.mock('openai', () => ({ default: OpenAICtor }));

import { GrokProvider } from './grok.provider';

const sample = {
  filePath: 'a.ts',
  lineNumber: 7,
  agentType: 'SECURITY',
  issue: 'Hardcoded token',
  suggestion: 'Move to env',
  priority: 'HIGH',
};

function chatResponse(content: string) {
  return { choices: [{ message: { content } }] };
}

describe('GrokProvider', () => {
  let provider: GrokProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GrokProvider('xai-test-key');
  });

  describe('constructor', () => {
    it('keeps historical summaries in the user context rather than system rules', async () => {
      mockCreate.mockResolvedValueOnce(chatResponse('[]'));
      await provider.analyzeCode('CURRENT_DIFF', [], undefined, { historicalContext: 'UNTRUSTED_HISTORY_PAYLOAD' });
      const request = mockCreate.mock.calls[0][0];
      expect(request.messages[0].content).not.toContain('UNTRUSTED_HISTORY_PAYLOAD');
      expect(request.messages[1].content).toContain('UNTRUSTED_HISTORY_PAYLOAD');
    });
    it('initializes OpenAI client pointed at the xAI baseURL', () => {
      new GrokProvider('xai-abc');
      const opts = OpenAICtor.mock.calls.at(-1)?.[0] as any;
      expect(opts.apiKey).toBe('xai-abc');
      expect(opts.baseURL).toBe('https://api.x.ai/v1');
    });

    it('respects GROK_BASE_URL env override at module load (sanity)', () => {
      // We cannot easily re-import with a new env, but we DO assert the default points to x.ai —
      // which is what catches the case where someone deletes the env-fallback by mistake.
      new GrokProvider('xai');
      const opts = OpenAICtor.mock.calls.at(-1)?.[0] as any;
      expect(opts.baseURL).toMatch(/x\.ai/);
    });
  });

  describe('analyzeCode() — happy path', () => {
    it('parses a JSON-array response', async () => {
      mockCreate.mockResolvedValueOnce(chatResponse(JSON.stringify([sample])));
      await expect(provider.analyzeCode('diff')).resolves.toEqual([sample]);
    });

    it('unwraps a single-key object wrapper', async () => {
      mockCreate.mockResolvedValueOnce(chatResponse(JSON.stringify({ findings: [sample] })));
      await expect(provider.analyzeCode('diff')).resolves.toEqual([sample]);
    });

    it('returns [] when wrapper value is not an array', async () => {
      mockCreate.mockResolvedValueOnce(chatResponse(JSON.stringify({ msg: 'ok' })));
      await expect(provider.analyzeCode('diff')).resolves.toEqual([]);
    });

    it('requests json_object response format', async () => {
      mockCreate.mockResolvedValueOnce(chatResponse('[]'));
      await provider.analyzeCode('diff');

      const call = mockCreate.mock.calls[0][0];
      expect(call.response_format).toEqual({ type: 'json_object' });
    });

    it('uses the grok model (grok-2-* by default)', async () => {
      mockCreate.mockResolvedValueOnce(chatResponse('[]'));
      await provider.analyzeCode('diff');
      const call = mockCreate.mock.calls[0][0];
      expect(call.model).toMatch(/^grok/);
    });

    it('passes the diff through in the user message', async () => {
      mockCreate.mockResolvedValueOnce(chatResponse('[]'));
      await provider.analyzeCode('SOME_DIFF', ['Rule Z']);

      const call = mockCreate.mock.calls[0][0];
      expect(call.messages[0].content).toContain('Rule Z');
      expect(call.messages[1].content).toContain('SOME_DIFF');
    });
  });

  describe('analyzeCode() — failure paths', () => {
    it('throws on invalid JSON content', async () => {
      mockCreate.mockResolvedValueOnce(chatResponse('not-valid-json'));
      await expect(provider.analyzeCode('diff')).rejects.toThrow(/Grok API request failed/);
    });

    it('throws when SDK rejects (e.g., 500)', async () => {
      mockCreate.mockRejectedValueOnce(new Error('500 upstream'));
      await expect(provider.analyzeCode('diff')).rejects.toThrow(/Grok API request failed/);
    });

    it('throws when there are no choices in the response', async () => {
      mockCreate.mockResolvedValueOnce({ choices: [] });
      await expect(provider.analyzeCode('diff')).rejects.toThrow(/Grok API request failed/);
    });
  });

  describe('analyzeCode() — additional edge cases', () => {
    it('returns [] when content is null (falls back to "{}")', async () => {
      mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: null } }] });
      await expect(provider.analyzeCode('diff')).resolves.toEqual([]);
    });

    it('does NOT use the default OpenAI base URL (must point to xAI)', () => {
      new GrokProvider('xai-123');
      const opts = OpenAICtor.mock.calls.at(-1)?.[0] as any;
      expect(opts.baseURL).not.toBe(undefined);
      expect(opts.baseURL).not.toMatch(/openai/i);
    });

    it('sends system + user messages in that order', async () => {
      mockCreate.mockResolvedValueOnce(chatResponse('[]'));
      await provider.analyzeCode('diff');
      const call = mockCreate.mock.calls[0][0];
      expect(call.messages[0].role).toBe('system');
      expect(call.messages[1].role).toBe('user');
    });

    it('logs to console.error on failure', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockCreate.mockRejectedValueOnce(new Error('upstream gone'));
      await expect(provider.analyzeCode('diff')).rejects.toThrow();
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('preserves multiple suggestions in returned array', async () => {
      const s2 = { ...sample, lineNumber: 88, issue: 'Other' };
      mockCreate.mockResolvedValueOnce(chatResponse(JSON.stringify([sample, s2])));
      await expect(provider.analyzeCode('diff')).resolves.toEqual([sample, s2]);
    });

    it('handles a JSON wrapper whose only value is an empty array', async () => {
      mockCreate.mockResolvedValueOnce(chatResponse(JSON.stringify({ findings: [] })));
      await expect(provider.analyzeCode('diff')).resolves.toEqual([]);
    });
  });
});
