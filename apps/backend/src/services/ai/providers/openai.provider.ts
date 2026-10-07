import OpenAI from 'openai';
import { BaseAiProvider, AiSuggestion, normalizeSuggestions, type AnalyzeOptions } from './base.provider';
import { type ReviewContext } from '../context-prompt';

export class OpenAiProvider extends BaseAiProvider {
  private aiClient: OpenAI;

  constructor(apiKey: string) {
    super(apiKey);
    this.aiClient = new OpenAI({ apiKey });
  }

  async analyzeCode(
    diff: string,
    customRules: string[] = [],
    context?: ReviewContext,
    options?: AnalyzeOptions,
  ): Promise<AiSuggestion[]> {
    try {
      const contextBlock = this.renderContext(context);

      const response = await this.aiClient.chat.completions.create({
        model: 'gpt-4o', // Utilizing top-tier omni model for extreme reasoning
        messages: [
          { role: 'system', content: this.getSystemPrompt(customRules) },
          { role: 'user', content: `${contextBlock}Here is the code diff:\n\n${diff}` }
        ],
        response_format: { type: 'json_object' }, // Enforce output structure parity
      }, { signal: options?.signal });

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
