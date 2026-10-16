import OpenAI from 'openai';
import { BaseAiProvider, AiSuggestion, type AnalyzeOptions, type JsonCompletionRequest } from './base.provider';
import { type ReviewContext } from '../context-prompt';
import { AiRequestError, assertAiPromptBudget, assertAiCompletion, MAX_AI_OUTPUT_TOKENS, parseAiJson, throwAiError } from '../ai-request-policy';

export class OpenAiProvider extends BaseAiProvider {
  private aiClient: OpenAI;

  constructor(apiKey: string) {
    super(apiKey);
    // BullMQ owns explicit transient retries; do not multiply them inside SDKs.
    this.aiClient = new OpenAI({ apiKey, maxRetries: 0 });
  }

  async analyzeCode(diff: string, customRules: string[] = [], context?: ReviewContext, options?: AnalyzeOptions): Promise<AiSuggestion[]> {
    const parsed = await this.completeJson({
      systemPrompt: this.getSystemPrompt(customRules),
      userPrompt: `${this.renderContext(context, options)}Here is the code diff:\n\n${this.renderReviewDiff(diff)}`,
      signal: options?.signal,
    });
    return this.reviewResponse(parsed, diff);
  }

  protected async completeJson(request: JsonCompletionRequest): Promise<unknown> {
    try {
      assertAiPromptBudget(request.systemPrompt, request.userPrompt);
      const response = await this.aiClient.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: MAX_AI_OUTPUT_TOKENS,
        messages: [{ role: 'system', content: request.systemPrompt }, { role: 'user', content: request.userPrompt }],
        response_format: { type: 'json_object' },
      }, { signal: request.signal });
      const choice = response.choices[0];
      assertAiCompletion('OpenAI', choice?.finish_reason);
      if (choice?.message.refusal) throw new AiRequestError('ai-response-blocked', 'OpenAI');
      return parseAiJson(choice?.message.content ?? '');
    } catch (error) { throwAiError('OpenAI', error); }
  }
}
