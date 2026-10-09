import { z } from 'zod';
import type { ChatMessage } from '../prompt.ts';
import { estimateTokens } from '../prompt.ts';
import {
  LlmError,
  postJson,
  usageOrEstimate,
  type Completion,
  type CompletionOptions,
  type LlmFetch,
} from '../provider.ts';

/** Response shape shared by Mistral, Groq and GitHub Models (OpenAI chat completions). */
export const ChatCompletionResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullish() }),
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().nullish(),
      completion_tokens: z.number().nullish(),
    })
    .nullish(),
});

export interface OpenAiCompatibleCall {
  fetch: LlmFetch;
  provider: string;
  url: string;
  headers: Record<string, string>;
  model: string;
  messages: ChatMessage[];
  options: CompletionOptions;
  /** Extra top-level body fields (e.g. response_format). */
  extra?: Record<string, unknown>;
  now?: () => number;
}

export async function openAiCompatibleComplete(call: OpenAiCompatibleCall): Promise<Completion> {
  const body = {
    model: call.model,
    messages: call.messages,
    max_tokens: call.options.maxTokens,
    temperature: 0,
    ...call.extra,
  };
  const res = await postJson({
    fetch: call.fetch,
    provider: call.provider,
    url: call.url,
    headers: call.headers,
    body,
    schema: ChatCompletionResponseSchema,
    signal: call.options.signal,
    ...(call.now ? { now: call.now } : {}),
  });
  const choice = res.choices[0];
  const text = choice?.message.content;
  if (typeof text !== 'string' || text.length === 0) throw new LlmError('bad_response', call.provider, 200);
  // A reply cut off at max_tokens is never valid JSON; treat it as a bad response so the chain retries elsewhere.
  if (choice?.finish_reason === 'length') throw new LlmError('bad_response', call.provider, 200);
  const usage = usageOrEstimate(
    { input: res.usage?.prompt_tokens, output: res.usage?.completion_tokens },
    estimateTokens(call.messages.map((m) => m.content).join('\n')),
    estimateTokens(text),
  );
  return { text, ...usage };
}
