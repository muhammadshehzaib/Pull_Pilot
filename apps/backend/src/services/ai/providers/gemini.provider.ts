import { GoogleGenerativeAI } from '@google/generative-ai';
import { BaseAiProvider, AiSuggestion, type AnalyzeOptions, type JsonCompletionRequest } from './base.provider';
import { type ReviewContext } from '../context-prompt';
import { AiRequestError, assertAiPromptBudget, assertAiCompletion, MAX_AI_OUTPUT_TOKENS, parseAiJson, throwAiError } from '../ai-request-policy';
import { observeUsage, tokenCount } from '../usage';

export class GeminiProvider extends BaseAiProvider {
  private aiClient: GoogleGenerativeAI;

  constructor(apiKey: string) {
    super(apiKey);
    this.aiClient = new GoogleGenerativeAI(apiKey);
  }

  async analyzeCode(diff: string, customRules: string[] = [], context?: ReviewContext, options?: AnalyzeOptions): Promise<AiSuggestion[]> {
    const parsed = await this.completeJson({
      systemPrompt: this.getSystemPrompt(customRules),
      userPrompt: `${this.renderContext(context, options)}Here is the GIT DIFF to review:\n\n${this.renderReviewDiff(diff)}`,
      signal: options?.signal,
      onUsage: options?.onUsage,
    });
    return this.reviewResponse(parsed, diff);
  }

  protected async completeJson(request: JsonCompletionRequest): Promise<unknown> {
    try {
      const prompt = `${request.systemPrompt}\n\n${request.userPrompt}`;
      assertAiPromptBudget(prompt);
      const model = this.aiClient.getGenerativeModel({
        model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: MAX_AI_OUTPUT_TOKENS },
      });
      const result = await model.generateContent(prompt, { signal: request.signal });
      const usage = result.response.usageMetadata;
      // SDK versions may omit thinking counts. Subtract input from total so billed
      // reasoning tokens are included instead of undercounting visible output only.
      const input = tokenCount(usage?.promptTokenCount);
      const total = tokenCount(usage?.totalTokenCount);
      observeUsage(request.onUsage, { provider: 'GEMINI', model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
        inputTokens: input, outputTokens: input !== null && total !== null && total >= input ? total - input : null,
        cachedInputTokens: tokenCount(usage?.cachedContentTokenCount), cacheWriteTokens: 0 });
      assertAiCompletion('Gemini', result.response.candidates?.[0]?.finishReason);
      if (result.response.promptFeedback?.blockReason) throw new AiRequestError('ai-response-blocked', 'Gemini');
      return parseAiJson(result.response.text());
    } catch (error) { throwAiError('Gemini', error); }
  }
}
