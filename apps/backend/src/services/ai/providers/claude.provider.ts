import Anthropic from '@anthropic-ai/sdk';
import { BaseAiProvider, AiSuggestion, normalizeSuggestions } from './base.provider';
import { CLAUDE_MODEL } from '../../../utils/constants';

export class ClaudeProvider extends BaseAiProvider {
  private aiClient: Anthropic;

  constructor(apiKey: string) {
    super(apiKey);
    this.aiClient = new Anthropic({ apiKey });
  }

  async analyzeCode(diff: string, customRules: string[] = []): Promise<AiSuggestion[]> {
    try {
      const systemPrompt = this.getSystemPrompt(customRules);

      const response = await this.aiClient.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [
          { role: 'user', content: `Here is the GIT DIFF to review:\n\n${diff}` },
        ],
      });

      const textBlock = response.content.find((b) => b.type === 'text');
      const raw = textBlock && 'text' in textBlock ? textBlock.text : '';

      // Anthropic has no native JSON-mode toggle — strip stray code fences defensively.
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      const parsed = JSON.parse(cleaned);

      const result = Array.isArray(parsed) ? parsed : (Object.values(parsed)[0] as unknown);
      return normalizeSuggestions(result);
    } catch (error) {
      console.error('🔴 Claude Provider Error:', error);
      throw new Error(`Claude API request failed: ${(error as Error).message}`);
    }
  }
}
