import type { z } from 'zod';
import type { ChatMessage } from './prompt.ts';

export type LlmFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ProviderCaps {
  requestsPerDay: number;
  tokensPerDay: number;
  requestsPerMinute: number;
}

export interface CompletionOptions {
  maxTokens: number;
  signal?: AbortSignal;
}

export interface Completion {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  readonly caps: ProviderCaps;
  complete(messages: ChatMessage[], options: CompletionOptions): Promise<Completion>;
}

export type LlmErrorCode = 'auth' | 'rate_limited' | 'quota' | 'server' | 'bad_response' | 'network';

/** Carries provider, code and status only; never a request or response body. */
export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly provider: string;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(code: LlmErrorCode, provider: string, status?: number, retryAfterMs?: number) {
    super(`llm ${provider}: ${code}${status === undefined ? '' : ` (http ${status})`}`);
    this.name = 'LlmError';
    this.code = code;
    this.provider = provider;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export const DEFAULT_LLM_TIMEOUT_MS = 30_000;

export function parseRetryAfterMs(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  // A non-positive value carries no useful wait; let the caller apply its default.
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds * 1000 : undefined;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return date - now > 0 ? date - now : undefined;
  return undefined;
}

export interface PostJsonOptions<T> {
  fetch: LlmFetch;
  provider: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  schema: z.ZodType<T>;
  signal?: AbortSignal | undefined;
  now?: () => number;
}

/**
 * POST a JSON body and parse the JSON reply with the provider's schema. HTTP and
 * network failures map to LlmError codes; the body is never included in errors.
 */
export async function postJson<T>(opts: PostJsonOptions<T>): Promise<T> {
  const now = opts.now ?? Date.now;
  let res: Response;
  try {
    res = await opts.fetch(opts.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...opts.headers },
      body: JSON.stringify(opts.body),
      signal: opts.signal ?? AbortSignal.timeout(DEFAULT_LLM_TIMEOUT_MS),
    });
  } catch {
    throw new LlmError('network', opts.provider);
  }
  if (res.status === 401 || res.status === 403) throw new LlmError('auth', opts.provider, res.status);
  if (res.status === 429) {
    throw new LlmError('rate_limited', opts.provider, 429, parseRetryAfterMs(res.headers.get('retry-after'), now()));
  }
  if (res.status === 402) throw new LlmError('quota', opts.provider, 402);
  if (res.status >= 500) {
    throw new LlmError('server', opts.provider, res.status, parseRetryAfterMs(res.headers.get('retry-after'), now()));
  }
  if (res.status < 200 || res.status >= 300) throw new LlmError('bad_response', opts.provider, res.status);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new LlmError('bad_response', opts.provider, res.status);
  }
  const parsed = opts.schema.safeParse(json);
  if (!parsed.success) throw new LlmError('bad_response', opts.provider, res.status);
  return parsed.data;
}

export function defaultFetch(): LlmFetch {
  return (input, init) => fetch(input, init);
}

/** Token usage reported by the API, or an estimate when it is missing. */
export function usageOrEstimate(
  reported: { input?: number | null | undefined; output?: number | null | undefined },
  estimateInput: number,
  estimateOutput: number,
): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens: typeof reported.input === 'number' ? reported.input : estimateInput,
    outputTokens: typeof reported.output === 'number' ? reported.output : estimateOutput,
  };
}
