import { z } from 'zod';
import type { ChatMessage } from '../prompt.ts';
import { SummaryOutputSchema } from '../schema.ts';
import { defaultFetch, type CompletionOptions, type LlmFetch, type LlmProvider } from '../provider.ts';
import { openAiCompatibleComplete } from './openai-compatible.ts';

/**
 * A llama.cpp server running next to the pipeline (plan 4.8 "local fallback"). It speaks the
 * OpenAI chat-completions dialect and supports grammar-constrained decoding from a JSON schema,
 * so every reply is structurally valid; the output validator still runs on top (plan 11.2).
 * No key, no quota: the only limits are the job's wall clock and the runner's CPU.
 */
export const LOCAL_LLAMA_DEFAULT_URL = 'http://127.0.0.1:8080';
export const LOCAL_LLAMA_DEFAULT_MODEL = 'qwen2.5-3b-instruct-q4_k_m';
/** A 3B model on 4 CPU cores needs well over the 30 s API default. */
export const LOCAL_LLAMA_TIMEOUT_MS = 180_000;
export const LOCAL_LLAMA_CAPS = {
  requestsPerDay: 1_000_000_000,
  tokensPerDay: 1_000_000_000_000,
  requestsPerMinute: 1_000_000,
};

/** The response schema handed to llama.cpp for constrained decoding. */
export function summaryJsonSchema(): Record<string, unknown> {
  // zod 4 emits draft-2020-12; llama.cpp's grammar converter understands object/array/enum/anyOf/
  // const, string min/max length and null, which is all this schema uses.
  const schema = z.toJSONSchema(SummaryOutputSchema, { target: 'draft-2020-12', unrepresentable: 'any' }) as Record<string, unknown>;
  delete schema['$schema'];
  return schema;
}

export interface LocalLlamaOptions {
  baseUrl?: string;
  model?: string;
  fetch?: LlmFetch;
  now?: () => number;
  timeoutMs?: number;
}

export function createLocalLlamaProvider(opts: LocalLlamaOptions = {}): LlmProvider {
  const fetchImpl = opts.fetch ?? defaultFetch();
  const model = opts.model ?? LOCAL_LLAMA_DEFAULT_MODEL;
  const baseUrl = (opts.baseUrl ?? LOCAL_LLAMA_DEFAULT_URL).replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? LOCAL_LLAMA_TIMEOUT_MS;
  const schema = summaryJsonSchema();
  return {
    name: 'local_llama',
    model,
    caps: LOCAL_LLAMA_CAPS,
    complete(messages: ChatMessage[], options: CompletionOptions) {
      return openAiCompatibleComplete({
        fetch: fetchImpl,
        provider: 'local_llama',
        url: `${baseUrl}/v1/chat/completions`,
        headers: {},
        model,
        messages,
        options: { ...options, signal: options.signal ?? AbortSignal.timeout(timeoutMs) },
        extra: {
          response_format: { type: 'json_schema', json_schema: { name: 'summary', schema, strict: true } },
        },
        ...(opts.now ? { now: opts.now } : {}),
      });
    },
  };
}
