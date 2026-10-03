import OpenAI from 'openai';
import { BaseAiProvider, AiSuggestion, normalizeSuggestions } from './base.provider';

const GROK_BASE_URL = process.env.GROK_BASE_URL || 'https://api.x.ai/v1';
const GROK_MODEL = process.env.GROK_MODEL || 'grok-2-1212';

export class GrokProvider extends BaseAiProvider {
  private aiClient: OpenAI;

  constructor(apiKey: string) {
    super(apiKey);
    // xAI exposes an OpenAI-compatible API surface; reuse the OpenAI client.
    this.aiClient = new OpenAI({ apiKey, baseURL: GROK_BASE_URL });
  }

  async analyzeCode(diff: string, customRules: string[] = []): Promise<AiSuggestion[]> {
    try {
      const response = await this.aiClient.chat.completions.create({
        model: GROK_MODEL,
        messages: [
          { role: 'system', content: this.getSystemPrompt(customRules) },
          { role: 'user', content: `Here is the code diff:\n\n${diff}` },
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
