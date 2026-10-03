import OpenAI from 'openai';
import { BaseAiProvider, AiSuggestion, normalizeSuggestions } from './base.provider';

export class OpenAiProvider extends BaseAiProvider {
  private aiClient: OpenAI;

  constructor(apiKey: string) {
    super(apiKey);
    this.aiClient = new OpenAI({ apiKey });
  }

  async analyzeCode(diff: string, customRules: string[] = []): Promise<AiSuggestion[]> {
    try {
      const response = await this.aiClient.chat.completions.create({
        model: 'gpt-4o', // Utilizing top-tier omni model for extreme reasoning
        messages: [
          { role: 'system', content: this.getSystemPrompt(customRules) },
          { role: 'user', content: `Here is the code diff:\n\n${diff}` }
        ],
        response_format: { type: 'json_object' }, // Enforce output structure parity
      });

      const content = response.choices[0].message.content || '{}';
      
      // Depending on internal prompts, OpenAI sometimes nests the array inside an object
      // Let's handle standard parsing.
      const rawData = JSON.parse(content);
      
      // Normalize to array if model wrapped it in a parent key like "suggestions"
      const result = Array.isArray(rawData) ? rawData : Object.values(rawData)[0];
      
      return normalizeSuggestions(result);

    } catch (error) {
      console.error('🔴 OpenAI Provider Error:', error);
      throw new Error(`OpenAI Request Failed: ${(error as Error).message}`);
    }
  }
}
