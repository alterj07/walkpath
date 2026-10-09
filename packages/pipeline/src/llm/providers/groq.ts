import type { ChatMessage } from '../prompt.ts';
import { defaultFetch, type CompletionOptions, type LlmFetch, type LlmProvider } from '../provider.ts';
import { openAiCompatibleComplete } from './openai-compatible.ts';

export const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const GROQ_DEFAULT_MODEL = 'openai/gpt-oss-20b';

/** Groq free tier (plan 4.8): ~1,000 requests but only 200k tokens per day. */
export const GROQ_CAPS = { requestsPerDay: 1_000, tokensPerDay: 200_000, requestsPerMinute: 30 };

export interface GroqOptions {
  apiKey: string;
  fetch?: LlmFetch;
  model?: string;
  now?: () => number;
}

export function createGroqProvider(opts: GroqOptions): LlmProvider {
  const fetchImpl = opts.fetch ?? defaultFetch();
  const model = opts.model ?? GROQ_DEFAULT_MODEL;
  return {
    name: 'groq',
    model,
    caps: GROQ_CAPS,
    complete(messages: ChatMessage[], options: CompletionOptions) {
      return openAiCompatibleComplete({
        fetch: fetchImpl,
        provider: 'groq',
        url: GROQ_URL,
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
