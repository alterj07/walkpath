import type { LlmFetch } from '../../src/llm/provider.ts';

export interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Reply = { status: number; json?: unknown; text?: string; headers?: Record<string, string> } | Error;

/** A fetch that replays scripted replies in order and records every call (body parsed, no secrets printed). */
export function fakeFetch(script: Reply[]): { fetch: LlmFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const queue = [...script];
  const fetch: LlmFetch = async (url, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    calls.push({ url, headers, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const reply = queue.shift();
    if (reply === undefined) throw new Error('fakeFetch: no reply scripted');
    if (reply instanceof Error) throw reply;
    const body = reply.text ?? (reply.json === undefined ? '' : JSON.stringify(reply.json));
    return new Response(body, { status: reply.status, headers: { 'content-type': 'application/json', ...reply.headers } });
  };
  return { fetch, calls };
}

export function openAiReply(content: string, usage?: { prompt_tokens: number; completion_tokens: number }): Reply {
  return { status: 200, json: { id: 'x', choices: [{ index: 0, message: { role: 'assistant', content } }], usage } };
}
