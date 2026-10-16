import OpenAI from 'openai';
import { BaseAiProvider, AiSuggestion, type AnalyzeOptions, type JsonCompletionRequest } from './base.provider';
import { type ReviewContext } from '../context-prompt';
import { GROK_BASE_URL, GROK_MODEL } from '../../../utils/constants';
import { AiRequestError, assertAiPromptBudget, assertAiCompletion, MAX_AI_OUTPUT_TOKENS, parseAiJson, throwAiError } from '../ai-request-policy';
import { observeUsage, tokenCount } from '../usage';

export class GrokProvider extends BaseAiProvider {
  private aiClient: OpenAI;

  constructor(apiKey: string) {
    super(apiKey);
    // BullMQ owns explicit transient retries; do not multiply them inside SDKs.
    this.aiClient = new OpenAI({ apiKey, baseURL: GROK_BASE_URL, maxRetries: 0 });
  }

  async analyzeCode(diff: string, customRules: string[] = [], context?: ReviewContext, options?: AnalyzeOptions): Promise<AiSuggestion[]> {
    const parsed = await this.completeJson({
      systemPrompt: this.getSystemPrompt(customRules),
      userPrompt: `${this.renderContext(context, options)}Here is the code diff:\n\n${this.renderReviewDiff(diff)}`,
      signal: options?.signal,
      onUsage: options?.onUsage,
    });
    return this.reviewResponse(parsed, diff);
  }

  protected async completeJson(request: JsonCompletionRequest): Promise<unknown> {
    try {
      assertAiPromptBudget(request.systemPrompt, request.userPrompt);
      const response = await this.aiClient.chat.completions.create({
        model: GROK_MODEL,
        max_tokens: MAX_AI_OUTPUT_TOKENS,
        messages: [{ role: 'system', content: request.systemPrompt }, { role: 'user', content: request.userPrompt }],
        response_format: { type: 'json_object' },
      }, { signal: request.signal });
      observeUsage(request.onUsage, { provider: 'GROK', model: response.model,
        inputTokens: tokenCount(response.usage?.prompt_tokens), outputTokens: tokenCount(response.usage?.completion_tokens),
        cachedInputTokens: tokenCount(response.usage?.prompt_tokens_details?.cached_tokens), cacheWriteTokens: 0 });
      const choice = response.choices[0];
      assertAiCompletion('Grok', choice?.finish_reason);
      if (choice?.message.refusal) throw new AiRequestError('ai-response-blocked', 'Grok');
      return parseAiJson(choice?.message.content ?? '');
    } catch (error) { throwAiError('Grok', error); }
  }
}
