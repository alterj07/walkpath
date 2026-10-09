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

export const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash-lite';

/**
 * Gemini free tier (plan 7.1): Google no longer publishes per-model limits;
 * community-reported Flash-Lite numbers are ~15 RPM and ~500 RPD. Free-tier data
 * is "used to improve our products"; only public posting text is sent.
 */
export const GEMINI_CAPS = { requestsPerDay: 500, tokensPerDay: 5_000_000, requestsPerMinute: 15 };

export function geminiUrl(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

export const GeminiResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({
            parts: z.array(z.object({ text: z.string().nullish() })).nullish(),
          })
          .nullish(),
        finishReason: z.string().nullish(),
      }),
    )
    .nullish(),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().nullish(),
      candidatesTokenCount: z.number().nullish(),
    })
    .nullish(),
});

export interface GeminiOptions {
  apiKey: string;
  fetch?: LlmFetch;
  model?: string;
  now?: () => number;
}

export function createGeminiProvider(opts: GeminiOptions): LlmProvider {
  const fetchImpl = opts.fetch ?? defaultFetch();
  const model = opts.model ?? GEMINI_DEFAULT_MODEL;
  return {
    name: 'gemini',
    model,
    caps: GEMINI_CAPS,
    async complete(messages: ChatMessage[], options: CompletionOptions): Promise<Completion> {
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
      const contents = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
      const body = {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents,
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: options.maxTokens,
          temperature: 0,
          // Flash-Lite "thinking" tokens count against maxOutputTokens; extraction needs none.
          thinkingConfig: { thinkingBudget: 0 },
        },
      };
      const res = await postJson({
        fetch: fetchImpl,
        provider: 'gemini',
        url: geminiUrl(model),
        headers: { 'x-goog-api-key': opts.apiKey },
        body,
        schema: GeminiResponseSchema,
        signal: options.signal,
        ...(opts.now ? { now: opts.now } : {}),
      });
      const candidate = res.candidates?.[0];
      const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (text.length === 0) throw new LlmError('bad_response', 'gemini', 200);
      // Truncated JSON never validates; fail fast so the chain moves on.
      if (candidate?.finishReason === 'MAX_TOKENS') throw new LlmError('bad_response', 'gemini', 200);
      const usage = usageOrEstimate(
        { input: res.usageMetadata?.promptTokenCount, output: res.usageMetadata?.candidatesTokenCount },
        estimateTokens(messages.map((m) => m.content).join('\n')),
        estimateTokens(text),
      );
      return { text, ...usage };
    },
  };
}
