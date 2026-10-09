import type { ChatMessage } from '../prompt.ts';
import { defaultFetch, type CompletionOptions, type LlmFetch, type LlmProvider } from '../provider.ts';
import { openAiCompatibleComplete } from './openai-compatible.ts';

export const GITHUB_MODELS_URL = 'https://models.github.ai/inference/chat/completions';
export const GITHUB_MODELS_DEFAULT_MODEL = 'openai/gpt-4o-mini';

/** GitHub Models low tier (plan 7.1): 150 requests/day, meant for experimentation. */
export const GITHUB_MODELS_CAPS = { requestsPerDay: 150, tokensPerDay: 2_000_000, requestsPerMinute: 15 };

export interface GithubModelsOptions {
  apiKey: string;
  fetch?: LlmFetch;
  model?: string;
  now?: () => number;
}

export function createGithubModelsProvider(opts: GithubModelsOptions): LlmProvider {
  const fetchImpl = opts.fetch ?? defaultFetch();
  const model = opts.model ?? GITHUB_MODELS_DEFAULT_MODEL;
  return {
    name: 'github_models',
    model,
    caps: GITHUB_MODELS_CAPS,
    complete(messages: ChatMessage[], options: CompletionOptions) {
      return openAiCompatibleComplete({
        fetch: fetchImpl,
        provider: 'github_models',
        url: GITHUB_MODELS_URL,
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
        model,
        messages,
        options,
        extra: { response_format: { type: 'json_object' } },
        ...(opts.now ? { now: opts.now } : {}),
      });
    },
  };
}
