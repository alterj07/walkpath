import type { ChatMessage } from '../prompt.ts';
import { defaultFetch, type CompletionOptions, type LlmFetch, type LlmProvider } from '../provider.ts';
import { openAiCompatibleComplete } from './openai-compatible.ts';

export const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';
export const MISTRAL_DEFAULT_MODEL = 'mistral-small-latest';

/**
 * Mistral Experiment plan (plan 7.1): 1 request/s, 500k tokens/min, 1B tokens/month.
 * Expressed per day: 30M tokens; requests are effectively uncapped by the daily budget.
 * Prompts on this plan may be used for training; only public posting text is sent.
 */
export const MISTRAL_CAPS = { requestsPerDay: 1_000_000_000, tokensPerDay: 30_000_000, requestsPerMinute: 60 };

export interface MistralOptions {
  apiKey: string;
  fetch?: LlmFetch;
  model?: string;
  now?: () => number;
}

export function createMistralProvider(opts: MistralOptions): LlmProvider {
  const fetchImpl = opts.fetch ?? defaultFetch();
  const model = opts.model ?? MISTRAL_DEFAULT_MODEL;
  return {
    name: 'mistral',
    model,
    caps: MISTRAL_CAPS,
    complete(messages: ChatMessage[], options: CompletionOptions) {
      return openAiCompatibleComplete({
        fetch: fetchImpl,
        provider: 'mistral',
        url: MISTRAL_URL,
        headers: { authorization: `Bearer ${opts.apiKey}` },
        model,
        messages,
        options,
        extra: { response_format: { type: 'json_object' } },
        ...(opts.now ? { now: opts.now } : {}),
      });
    },
  };
}
