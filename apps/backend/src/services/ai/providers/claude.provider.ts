import Anthropic from '@anthropic-ai/sdk';
import { BaseAiProvider, AiSuggestion, type AnalyzeOptions, type JsonCompletionRequest } from './base.provider';
import { type ReviewContext } from '../context-prompt';
import { CLAUDE_MODEL } from '../../../utils/constants';
import { assertAiPromptBudget, assertAiCompletion, MAX_AI_OUTPUT_TOKENS, parseAiJson, throwAiError } from '../ai-request-policy';
import { observeUsage, tokenCount } from '../usage';

export class ClaudeProvider extends BaseAiProvider {
  private aiClient: Anthropic;

  constructor(apiKey: string) {
    super(apiKey);
    // BullMQ owns explicit transient retries; do not multiply them inside SDKs.
    this.aiClient = new Anthropic({ apiKey, maxRetries: 0 });
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
      assertAiPromptBudget(request.systemPrompt, request.userPrompt);
      const response = await this.aiClient.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: MAX_AI_OUTPUT_TOKENS,
        system: request.systemPrompt,
        messages: [{ role: 'user', content: request.userPrompt }],
      }, { signal: request.signal });
      // The installed SDK predates cache fields returned by newer endpoints.
      const usage = response.usage as typeof response.usage & {
        cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
      };
      const input = tokenCount(usage?.input_tokens);
      const cached = tokenCount(usage?.cache_read_input_tokens);
      const written = tokenCount(usage?.cache_creation_input_tokens);
      observeUsage(request.onUsage, { provider: 'CLAUDE', model: response.model,
        inputTokens: input === null ? null : input + (cached ?? 0) + (written ?? 0),
        outputTokens: tokenCount(response.usage?.output_tokens), cachedInputTokens: cached, cacheWriteTokens: written });
      assertAiCompletion('Claude', response.stop_reason);
      const textBlock = response.content.find(b => b.type === 'text');
      const raw = textBlock && 'text' in textBlock ? textBlock.text : '';
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      return parseAiJson(cleaned);
    } catch (error) { throwAiError('Claude', error); }
  }
}
