import type { StateDb } from '../state/db.ts';
import { buildPrompt, htmlToText, parseJsonReply, RETRY_INSTRUCTION, type ChatMessage } from './prompt.ts';
import { LlmError, type LlmProvider } from './provider.ts';
import { validateSummaryOutput, type SummaryOutput } from './schema.ts';
import { createGeminiProvider } from './providers/gemini.ts';
import { createGithubModelsProvider } from './providers/github-models.ts';
import { createGroqProvider } from './providers/groq.ts';
import { createMistralProvider } from './providers/mistral.ts';
import { createWorkersAiProvider } from './providers/workers-ai.ts';

export const DEFAULT_MAX_TOKENS = 600;
export const DEFAULT_COOLDOWN_MS = 5 * 60_000;
/** First server error: a short pause; repeated ones escalate to the default cooldown. */
export const SERVER_FIRST_COOLDOWN_MS = 30_000;
/** The longest we wait in-line for a provider's per-minute window; longer waits skip to the next provider. */
export const MAX_INLINE_WAIT_MS = 2_000;

export interface SummarizeJob {
  job_id: string;
  title: string;
  company: string;
  location: string;
  descriptionHtml: string;
}

export type SummarizeResult =
  | { ok: true; output: SummaryOutput; provider: string; model: string }
  | { ok: false; reason: 'exhausted' | 'invalid' };

export interface SummarizerOptions {
  providers: LlmProvider[];
  db: StateDb;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  maxTokens?: number;
}

export interface Summarizer {
  summarize(job: SummarizeJob): Promise<SummarizeResult>;
  /** Providers that can still take a request right now (for reporting). */
  availableProviders(): string[];
}

interface ProviderState {
  provider: LlmProvider;
  requestsToday: number;
  tokensToday: number;
  cooldownUntil: number;
  disabled: boolean;
  /** Failures since the last successful completion; drives escalating cooldowns. */
  consecutiveFailures: number;
  /** Timestamps (ms) of requests in the last minute, for the rpm window. */
  recent: number[];
  day: string;
}

export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Walks the provider chain in order, keeping every provider inside its free-tier
 * caps (plan 4.8). Usage is read from `llm_usage` at the start of each day and
 * accumulated in memory during the run.
 */
export function createSummarizer(opts: SummarizerOptions): Summarizer {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? (() => {});
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

  const states: ProviderState[] = opts.providers.map((provider) => ({
    provider,
    requestsToday: 0,
    tokensToday: 0,
    cooldownUntil: 0,
    disabled: false,
    consecutiveFailures: 0,
    recent: [],
    day: '',
  }));

  function refreshDay(s: ProviderState, t: number): void {
    const day = dayOf(t);
    if (s.day === day) return;
    const row = opts.db.getLlmUsage(day).find((r) => r.provider === s.provider.name);
    s.requestsToday = row?.requests ?? 0;
    s.tokensToday = row?.tokens ?? 0;
    s.day = day;
  }

  function capReached(s: ProviderState): boolean {
    const caps = s.provider.caps;
    return s.requestsToday >= caps.requestsPerDay || s.tokensToday >= caps.tokensPerDay;
  }

  /** ms to wait before the provider's per-minute window has room; 0 when ready. */
  function rpmWait(s: ProviderState, t: number): number {
    s.recent = s.recent.filter((ts) => t - ts < 60_000);
    if (s.recent.length < s.provider.caps.requestsPerMinute) return 0;
    const oldest = s.recent[0] ?? t;
    return Math.max(0, oldest + 60_000 - t);
  }

  function available(s: ProviderState, t: number): boolean {
    refreshDay(s, t);
    return !s.disabled && t >= s.cooldownUntil && !capReached(s);
  }

  function recordFailure(s: ProviderState, err: LlmError, t: number): void {
    s.consecutiveFailures += 1;
    const n = s.consecutiveFailures;
    let cooldown: number | null = null;
    switch (err.code) {
      case 'auth':
        s.disabled = true;
        log(`llm ${s.provider.name}: auth failure, disabled for this run`);
        return;
      case 'rate_limited':
      case 'quota':
        cooldown = err.retryAfterMs ?? DEFAULT_COOLDOWN_MS;
        break;
      case 'server':
        // One blip: pause briefly. Three in a row: treat it as an outage.
        cooldown = err.retryAfterMs ?? (n >= 3 ? DEFAULT_COOLDOWN_MS : SERVER_FIRST_COOLDOWN_MS);
        break;
      case 'network':
      case 'bad_response':
        // A single odd reply moves on to the next provider for this job only;
        // two in a row means the provider is unhealthy for a while.
        if (n >= 2) cooldown = DEFAULT_COOLDOWN_MS;
        break;
    }
    if (cooldown !== null) {
      s.cooldownUntil = t + cooldown;
      log(`llm ${s.provider.name}: ${err.code} (x${n}), cooldown ${Math.round(cooldown / 1000)}s`);
    }
  }

  async function callOnce(s: ProviderState, messages: ChatMessage[]): Promise<string | null> {
    const t = now();
    const wait = rpmWait(s, t);
    if (wait > MAX_INLINE_WAIT_MS) return null;
    if (wait > 0) await sleep(wait);
    const started = now();
    s.recent.push(started);
    try {
      const completion = await s.provider.complete(messages, { maxTokens });
      const tokens = completion.inputTokens + completion.outputTokens;
      s.requestsToday += 1;
      s.tokensToday += tokens;
      s.consecutiveFailures = 0;
      opts.db.addLlmUsage(dayOf(started), s.provider.name, 1, tokens);
      return completion.text;
    } catch (err) {
      // A failed request still counted against the provider's quota in most cases.
      s.requestsToday += 1;
      opts.db.addLlmUsage(dayOf(started), s.provider.name, 1, 0);
      if (err instanceof LlmError) {
        recordFailure(s, err, now());
        return null;
      }
      // Anything else is a bug in a provider, not a provider outage: surface it.
      throw err;
    }
  }

  return {
    availableProviders() {
      const t = now();
      return states.filter((s) => available(s, t)).map((s) => s.provider.name);
    },

    async summarize(job: SummarizeJob): Promise<SummarizeResult> {
      const messages = buildPrompt({
        title: job.title,
        company: job.company,
        location: job.location,
        descriptionText: htmlToText(job.descriptionHtml),
      });
      let anyAvailable = false;
      let lastInvalid = false;

      for (const s of states) {
        if (!available(s, now())) continue;
        anyAvailable = true;

        const text = await callOnce(s, messages);
        if (text === null) continue;

        const first = validateSummaryOutput(parseJsonReply(text));
        if (first.ok) return { ok: true, output: first.value, provider: s.provider.name, model: s.provider.model };
        log(`llm ${s.provider.name}: invalid output for ${job.job_id} (${first.reason.split(':')[0]}), retrying once`);
        lastInvalid = true;

        if (!available(s, now())) continue;
        const retryMessages: ChatMessage[] = [...messages, { role: 'user', content: RETRY_INSTRUCTION }];
        const retryText = await callOnce(s, retryMessages);
        if (retryText === null) continue;
        const second = validateSummaryOutput(parseJsonReply(retryText));
        if (second.ok) return { ok: true, output: second.value, provider: s.provider.name, model: s.provider.model };
        log(`llm ${s.provider.name}: invalid output for ${job.job_id} after retry, moving on`);
      }

      return { ok: false, reason: anyAvailable && lastInvalid ? 'invalid' : 'exhausted' };
    },
  };
}

export interface ProviderEnv {
  MISTRAL_API_KEY?: string | undefined;
  GEMINI_API_KEY?: string | undefined;
  CLOUDFLARE_ACCOUNT_ID?: string | undefined;
  CLOUDFLARE_AI_TOKEN?: string | undefined;
  GROQ_API_KEY?: string | undefined;
  GITHUB_MODELS_TOKEN?: string | undefined;
}

/** The provider chain in the plan's order (4.8), skipping providers whose secrets are missing. */
export function providersFromEnv(env: ProviderEnv): LlmProvider[] {
  const chain: LlmProvider[] = [];
  if (env.MISTRAL_API_KEY) chain.push(createMistralProvider({ apiKey: env.MISTRAL_API_KEY }));
  if (env.GEMINI_API_KEY) chain.push(createGeminiProvider({ apiKey: env.GEMINI_API_KEY }));
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_AI_TOKEN) {
    chain.push(createWorkersAiProvider({ apiKey: env.CLOUDFLARE_AI_TOKEN, accountId: env.CLOUDFLARE_ACCOUNT_ID }));
  }
  if (env.GROQ_API_KEY) chain.push(createGroqProvider({ apiKey: env.GROQ_API_KEY }));
  if (env.GITHUB_MODELS_TOKEN) chain.push(createGithubModelsProvider({ apiKey: env.GITHUB_MODELS_TOKEN }));
  return chain;
}

/** Per-provider usage for meta.json. */
export function summaryUsageReport(db: StateDb, day: string): Record<string, { requests: number; tokens: number }> {
  const out: Record<string, { requests: number; tokens: number }> = {};
  for (const row of db.getLlmUsage(day)) out[row.provider] = { requests: row.requests, tokens: row.tokens };
  return out;
}
