import { z } from 'zod';
import type { ChatMessage } from '../prompt.ts';
import { estimateTokens } from '../prompt.ts';
import {
  LlmError,
  defaultFetch,
  postJson,
  usageOrEstimate,
  type Completion,
  type CompletionOptions,
  type LlmFetch,
  type LlmProvider,
} from '../provider.ts';

export const WORKERS_AI_DEFAULT_MODEL = '@cf/meta/llama-3.2-3b-instruct';

/** Cloudflare Workers AI free tier (plan 7.1): 10,000 neurons/day ≈ 450 jobs on Llama 3.2 3B. */
export const WORKERS_AI_CAPS = { requestsPerDay: 450, tokensPerDay: 2_000_000, requestsPerMinute: 30 };

export function workersAiUrl(accountId: string, model: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`;
}

export const WorkersAiResponseSchema = z.object({
  success: z.boolean().nullish(),
  result: z
    .object({
      response: z.string().nullish(),
      usage: z
        .object({
          prompt_tokens: z.number().nullish(),
          completion_tokens: z.number().nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

export interface WorkersAiOptions {
  apiKey: string;
  accountId: string;
  fetch?: LlmFetch;
  model?: string;
  now?: () => number;
}

export function createWorkersAiProvider(opts: WorkersAiOptions): LlmProvider {
  const fetchImpl = opts.fetch ?? defaultFetch();
  const model = opts.model ?? WORKERS_AI_DEFAULT_MODEL;
  return {
    name: 'workers_ai',
    model,
    caps: WORKERS_AI_CAPS,
    async complete(messages: ChatMessage[], options: CompletionOptions): Promise<Completion> {
      const res = await postJson({
        fetch: fetchImpl,
        provider: 'workers_ai',
        url: workersAiUrl(opts.accountId, model),
        headers: { authorization: `Bearer ${opts.apiKey}` },
        body: { messages, max_tokens: options.maxTokens, temperature: 0 },
        schema: WorkersAiResponseSchema,
        signal: options.signal,
        ...(opts.now ? { now: opts.now } : {}),
      });
      const text = res.result?.response ?? '';
      if (res.success === false || text.length === 0) throw new LlmError('bad_response', 'workers_ai', 200);
      const usage = usageOrEstimate(
        { input: res.result?.usage?.prompt_tokens, output: res.result?.usage?.completion_tokens },
        estimateTokens(messages.map((m) => m.content).join('\n')),
        estimateTokens(text),
      );
      return { text, ...usage };
    },
  };
}
