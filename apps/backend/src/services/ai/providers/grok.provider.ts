import OpenAI from 'openai';
import { BaseAiProvider, AiSuggestion, normalizeSuggestions } from './base.provider';
import { type ReviewContext } from '../context-prompt';
import { GROK_BASE_URL, GROK_MODEL } from '../../../utils/constants';

export class GrokProvider extends BaseAiProvider {
  private aiClient: OpenAI;

  constructor(apiKey: string) {
    super(apiKey);
    // xAI exposes an OpenAI-compatible API surface; reuse the OpenAI client.
    this.aiClient = new OpenAI({ apiKey, baseURL: GROK_BASE_URL });
  }

  async analyzeCode(
    diff: string,
    customRules: string[] = [],
    context?: ReviewContext,
  ): Promise<AiSuggestion[]> {
    try {
      const contextBlock = this.renderContext(context);

      const response = await this.aiClient.chat.completions.create({
        model: GROK_MODEL,
        messages: [
          { role: 'system', content: this.getSystemPrompt(customRules) },
          { role: 'user', content: `${contextBlock}Here is the code diff:\n\n${diff}` },
        ],
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0].message.content || '{}';
      const rawData = JSON.parse(content);
      const result = Array.isArray(rawData) ? rawData : Object.values(rawData)[0];
      return normalizeSuggestions(result);
    } catch (error) {
      console.error('🔴 Grok Provider Error:', error);
      throw new Error(`Grok API request failed: ${(error as Error).message}`);
    }
  }
}
