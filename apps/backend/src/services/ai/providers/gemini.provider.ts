import { GoogleGenerativeAI } from '@google/generative-ai';
import { BaseAiProvider, AiSuggestion, type AnalyzeOptions, type JsonCompletionRequest } from './base.provider';
import { type ReviewContext } from '../context-prompt';

export class GeminiProvider extends BaseAiProvider {
  private aiClient: GoogleGenerativeAI;

  constructor(apiKey: string) {
    super(apiKey);
    this.aiClient = new GoogleGenerativeAI(apiKey);
  }

  async analyzeCode(
    diff: string,
    customRules: string[] = [],
    context?: ReviewContext,
    options?: AnalyzeOptions,
  ): Promise<AiSuggestion[]> {
    try {
      // 1. Initialize modern ultra-performant model
      const model = this.aiClient.getGenerativeModel({ 
        model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
        generationConfig: {
           responseMimeType: "application/json" // Forces structural output!
        }
      });

      const systemPrompt = this.getSystemPrompt(customRules);
      const contextBlock = this.renderContext(context, options);

      const prompt = `
        ${systemPrompt}
        
        ${contextBlock}
        Here is the GIT DIFF to review:
        
        ${this.renderReviewDiff(diff)}
      `;

      const result = await model.generateContent(prompt, { signal: options?.signal });
      const responseText = result.response.text();

      const rawData = this.parseReviewResponse(responseText);
      const normalized = Array.isArray(rawData) ? rawData : Object.values(rawData)[0];
      return this.normalizeReviewFindings(normalized, diff);
      
    } catch (error) {
      console.error('🔴 Gemini Provider Error:', error);
      throw new Error(`Gemini API request failed: ${(error as Error).message}`);
    }
  }

  protected async completeJson(request: JsonCompletionRequest): Promise<unknown> {
    const model = this.aiClient.getGenerativeModel({
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      generationConfig: { responseMimeType: 'application/json' },
    });

    const result = await model.generateContent(
      `${request.systemPrompt}\n\n${request.userPrompt}`,
      { signal: request.signal },
    );

    return JSON.parse(result.response.text());
  }
}
