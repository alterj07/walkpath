import { describe, expect, it } from 'vitest';
import { LlmError, parseRetryAfterMs } from '../../src/llm/provider.ts';
import { createMistralProvider, MISTRAL_URL } from '../../src/llm/providers/mistral.ts';
import { createGeminiProvider, geminiUrl } from '../../src/llm/providers/gemini.ts';
import { createWorkersAiProvider, workersAiUrl } from '../../src/llm/providers/workers-ai.ts';
import { createGroqProvider, GROQ_URL } from '../../src/llm/providers/groq.ts';
import { createGithubModelsProvider, GITHUB_MODELS_URL } from '../../src/llm/providers/github-models.ts';
import { fakeFetch, openAiReply } from './fake-fetch.ts';

const messages = [
  { role: 'system' as const, content: 'extract' },
  { role: 'user' as const, content: 'Title: X' },
];
const opts = { maxTokens: 400 };

describe('mistral', () => {
  it('posts an OpenAI-shaped body with json_object mode and parses usage', async () => {
    const { fetch, calls } = fakeFetch([openAiReply('{"a":1}', { prompt_tokens: 120, completion_tokens: 30 })]);
    const p = createMistralProvider({ apiKey: 'sk-test', fetch });
    const out = await p.complete(messages, opts);
    expect(out).toEqual({ text: '{"a":1}', inputTokens: 120, outputTokens: 30 });
    expect(calls[0]?.url).toBe(MISTRAL_URL);
    expect(calls[0]?.headers.authorization).toBe('Bearer sk-test');
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body.model).toBe('mistral-small-latest');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.max_tokens).toBe(400);
    expect(body.messages).toEqual(messages);
  });

  it('estimates tokens when usage is missing', async () => {
    const { fetch } = fakeFetch([openAiReply('{"abcd":1}')]);
    const out = await createMistralProvider({ apiKey: 'k', fetch }).complete(messages, opts);
    expect(out.inputTokens).toBe(Math.ceil('extract\nTitle: X'.length / 4));
    expect(out.outputTokens).toBe(Math.ceil('{"abcd":1}'.length / 4));
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [402, 'quota'],
    [429, 'rate_limited'],
    [500, 'server'],
    [503, 'server'],
    [418, 'bad_response'],
  ])('maps http %s to %s without leaking the body', async (status, code) => {
    const { fetch } = fakeFetch([{ status, json: { error: 'SECRET-BODY-TEXT' }, headers: { 'retry-after': '7' } }]);
    const err = await createMistralProvider({ apiKey: 'k', fetch })
      .complete(messages, opts)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    const e = err as LlmError;
    expect(e.code).toBe(code);
    expect(e.provider).toBe('mistral');
    expect(e.status).toBe(status);
    expect(e.message).not.toContain('SECRET');
    if (code === 'rate_limited' || code === 'server') expect(e.retryAfterMs).toBe(7000);
  });

  it('maps network failures and unparseable bodies', async () => {
    const net = fakeFetch([new Error('ECONNRESET')]);
    const e1 = (await createMistralProvider({ apiKey: 'k', fetch: net.fetch })
      .complete(messages, opts)
      .catch((e: unknown) => e)) as LlmError;
    expect(e1.code).toBe('network');
    const bad = fakeFetch([{ status: 200, text: '<html>cloudflare challenge</html>' }]);
    const e2 = (await createMistralProvider({ apiKey: 'k', fetch: bad.fetch })
      .complete(messages, opts)
      .catch((e: unknown) => e)) as LlmError;
    expect(e2.code).toBe('bad_response');
    expect(e2.message).not.toContain('cloudflare');
    const shape = fakeFetch([{ status: 200, json: { choices: [] } }]);
    const e3 = (await createMistralProvider({ apiKey: 'k', fetch: shape.fetch })
      .complete(messages, opts)
      .catch((e: unknown) => e)) as LlmError;
    expect(e3.code).toBe('bad_response');
  });

  it('treats a reply truncated at max_tokens as bad_response', async () => {
    const { fetch } = fakeFetch([
      { status: 200, json: { choices: [{ message: { content: '{"summary": "cut off' }, finish_reason: 'length' }] } },
    ]);
    const e = (await createMistralProvider({ apiKey: 'k', fetch }).complete(messages, opts).catch((e: unknown) => e)) as LlmError;
    expect(e.code).toBe('bad_response');
    const ok = fakeFetch([{ status: 200, json: { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] } }]);
    expect((await createMistralProvider({ apiKey: 'k', fetch: ok.fetch }).complete(messages, opts)).text).toBe('{}');
  });
});

describe('gemini', () => {
  it('uses the x-goog-api-key header, systemInstruction and JSON mime type, and parses candidates', async () => {
    const { fetch, calls } = fakeFetch([
      {
        status: 200,
        json: {
          candidates: [{ content: { parts: [{ text: '{"b":' }, { text: '2}' }], role: 'model' }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 9, totalTokenCount: 59 },
          modelVersion: 'gemini-2.5-flash-lite',
        },
      },
    ]);
    const out = await createGeminiProvider({ apiKey: 'g-key', fetch }).complete(messages, opts);
    expect(out).toEqual({ text: '{"b":2}', inputTokens: 50, outputTokens: 9 });
    expect(calls[0]?.url).toBe(geminiUrl('gemini-2.5-flash-lite'));
    expect(calls[0]?.headers['x-goog-api-key']).toBe('g-key');
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'extract' }] });
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'Title: X' }] }]);
    const gen = body.generationConfig as Record<string, unknown>;
    expect(gen.responseMimeType).toBe('application/json');
    expect(gen.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it('treats a MAX_TOKENS candidate as bad_response', async () => {
    const { fetch } = fakeFetch([
      { status: 200, json: { candidates: [{ content: { parts: [{ text: '{"summary": "cut' }] }, finishReason: 'MAX_TOKENS' }] } },
    ]);
    const e = (await createGeminiProvider({ apiKey: 'k', fetch }).complete(messages, opts).catch((e: unknown) => e)) as LlmError;
    expect(e.code).toBe('bad_response');
  });

  it('treats an empty candidate list as bad_response and 429 as rate_limited with a date Retry-After', async () => {
    const empty = fakeFetch([{ status: 200, json: { candidates: [] } }]);
    const e1 = (await createGeminiProvider({ apiKey: 'k', fetch: empty.fetch })
      .complete(messages, opts)
      .catch((e: unknown) => e)) as LlmError;
    expect(e1.code).toBe('bad_response');
    const now = Date.UTC(2026, 9, 9, 12, 0, 0);
    const limited = fakeFetch([
      { status: 429, json: {}, headers: { 'retry-after': new Date(now + 90_000).toUTCString() } },
    ]);
    const e2 = (await createGeminiProvider({ apiKey: 'k', fetch: limited.fetch, now: () => now })
      .complete(messages, opts)
      .catch((e: unknown) => e)) as LlmError;
    expect(e2.code).toBe('rate_limited');
    expect(e2.retryAfterMs).toBe(90_000);
  });
});

describe('workers ai', () => {
  it('posts to the account run endpoint with a bearer token and parses result.response', async () => {
    const { fetch, calls } = fakeFetch([
      {
        status: 200,
        json: { result: { response: '{"c":3}', usage: { prompt_tokens: 40, completion_tokens: 8 } }, success: true, errors: [], messages: [] },
      },
    ]);
    const out = await createWorkersAiProvider({ apiKey: 'cf', accountId: 'acct1', fetch }).complete(messages, opts);
    expect(out).toEqual({ text: '{"c":3}', inputTokens: 40, outputTokens: 8 });
    expect(calls[0]?.url).toBe(workersAiUrl('acct1', '@cf/meta/llama-3.2-3b-instruct'));
    expect(calls[0]?.headers.authorization).toBe('Bearer cf');
    expect((calls[0]?.body as Record<string, unknown>).messages).toEqual(messages);
  });

  it('treats success:false as bad_response', async () => {
    const { fetch } = fakeFetch([{ status: 200, json: { success: false, result: null, errors: [{ code: 1 }] } }]);
    const e = (await createWorkersAiProvider({ apiKey: 'cf', accountId: 'a', fetch })
      .complete(messages, opts)
      .catch((e: unknown) => e)) as LlmError;
    expect(e.code).toBe('bad_response');
  });
});

describe('groq and github models', () => {
  it('groq posts OpenAI-shaped bodies to its endpoint', async () => {
    const { fetch, calls } = fakeFetch([openAiReply('{"d":4}', { prompt_tokens: 1, completion_tokens: 1 })]);
    const out = await createGroqProvider({ apiKey: 'gq', fetch }).complete(messages, opts);
    expect(out.text).toBe('{"d":4}');
    expect(calls[0]?.url).toBe(GROQ_URL);
    expect((calls[0]?.body as Record<string, unknown>).model).toBe('openai/gpt-oss-20b');
  });

  it('github models posts with the api-version header', async () => {
    const { fetch, calls } = fakeFetch([openAiReply('{"e":5}')]);
    const out = await createGithubModelsProvider({ apiKey: 'ghp', fetch }).complete(messages, opts);
    expect(out.text).toBe('{"e":5}');
    expect(calls[0]?.url).toBe(GITHUB_MODELS_URL);
    expect(calls[0]?.headers['x-github-api-version']).toBe('2022-11-28');
    expect(calls[0]?.headers.accept).toBe('application/vnd.github+json');
    expect((calls[0]?.body as Record<string, unknown>).model).toBe('openai/gpt-4o-mini');
  });

  it('a null content string is bad_response', async () => {
    const { fetch } = fakeFetch([{ status: 200, json: { choices: [{ message: { content: null } }] } }]);
    const e = (await createGroqProvider({ apiKey: 'k', fetch }).complete(messages, opts).catch((e: unknown) => e)) as LlmError;
    expect(e.code).toBe('bad_response');
  });
});

describe('parseRetryAfterMs', () => {
  it('parses seconds and HTTP dates; non-positive values and junk are undefined', () => {
    const now = 1_000_000;
    expect(parseRetryAfterMs('3', now)).toBe(3000);
    expect(parseRetryAfterMs('0', now)).toBeUndefined();
    expect(parseRetryAfterMs('-5', now)).toBeUndefined();
    expect(parseRetryAfterMs(new Date(now - 5000).toUTCString(), now)).toBeUndefined();
    expect(parseRetryAfterMs(new Date(now + 5000).toUTCString(), now)).toBe(5000);
    expect(parseRetryAfterMs('soon', now)).toBeUndefined();
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
  });
});
