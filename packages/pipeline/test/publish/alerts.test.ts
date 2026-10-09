import { describe, expect, it } from 'vitest';
import {
  DISCORD_MESSAGE_MAX_CHARS,
  TELEGRAM_MESSAGE_MAX_CHARS,
  discordPayloads,
  escapeDiscord,
  escapeTelegramHtml,
  postDiscord,
  postTelegram,
  relativePosted,
  telegramMessages,
} from '../../src/publish/alerts.ts';
import { SAFETY_LINE } from '../../src/publish/feeds.ts';
import { makeRecord } from './record-fixture.ts';

const now = new Date('2026-10-09T16:14:00.000Z');
const hostile = makeRecord({
  id: 'bbbbbbbbbbbb',
  title: '@everyone *bold* <b>x</b> [x](http://evil.example) _u_ ~s~ `c`',
  company: { slug: 'evil', name: 'Evil & Co', domain: 'evil.example' },
  apply_url: 'https://evil.example/phish',
  summary: { text: 'Visit http://evil.example now @here', responsibilities: [], qualifications: [], must_have_skills: [], nice_to_have_skills: [], model: 'm', generated_at: '2026-10-09T14:33:02.000Z' },
});

describe('escaping', () => {
  it('neutralises Discord markdown and mentions', () => {
    const s = escapeDiscord('@everyone *bold* _u_ ~s~ `c` |x| >q [l](u) #h');
    expect(s).not.toMatch(/(^|[^\\])\*bold\*/);
    expect(s).toContain('@​everyone');
    expect(s).toContain('\\*bold\\*');
    expect(s).toContain('\\[l\\]\\(u\\)');
  });
  it('escapes Telegram HTML', () => {
    expect(escapeTelegramHtml('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;');
  });
  it('formats relative times', () => {
    expect(relativePosted('2026-10-09T16:00:00.000Z', now)).toBe('14 min ago');
    expect(relativePosted('2026-10-09T10:00:00.000Z', now)).toBe('6 h ago');
    expect(relativePosted('2026-10-01T10:00:00.000Z', now)).toBe('8 d ago');
  });
});

describe('discordPayloads', () => {
  const records = Array.from({ length: 23 }, (_, i) => makeRecord({ id: i.toString(16).padStart(12, '0') })).concat([hostile]);
  const payloads = discordPayloads(records, { siteUrl: 'https://walkpath.pages.dev', now }) as Array<{
    allowed_mentions: { parse: string[] };
    embeds: Array<{ title: string; url: string; description: string; fields: Array<{ name: string; value: string }>; footer: { text: string } }>;
  }>;

  it('batches 10 embeds per message and disables mentions', () => {
    expect(payloads.map((p) => p.embeds.length)).toEqual([10, 10, 4]);
    for (const p of payloads) expect(p.allowed_mentions).toEqual({ parse: [] });
  });

  it('links only to our job page and escapes hostile text', () => {
    const embed = payloads[2]!.embeds[3]!;
    expect(embed.url).toBe('https://walkpath.pages.dev/job/bbbbbbbbbbbb');
    expect(JSON.stringify(payloads)).not.toContain('evil.example/phish');
    expect(embed.title).toContain('@​everyone');
    expect(embed.title).toContain('\\*bold\\*');
    expect(embed.title).toContain('\\[x\\]\\(http://evil.example\\)');
    expect(embed.description).toContain('@​here');
    expect(embed.footer.text).toBe(SAFETY_LINE);
    expect(embed.fields.map((f) => f.name)).toEqual(['Location', 'Posted', 'Season']);
    expect(embed.fields[1]!.value).toBe('2 h ago');
  });
});

describe('telegramMessages', () => {
  it('uses HTML mode with escaped text and our links only', () => {
    const msgs = telegramMessages([makeRecord(), hostile], { siteUrl: 'https://walkpath.pages.dev', now });
    expect(msgs).toHaveLength(1);
    const m = msgs[0]!;
    expect(m).toContain('<a href="https://walkpath.pages.dev/job/a9f3c2e17b04">Flight Software Intern Summer 2027</a>');
    expect(m).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(m).toContain('Evil &amp; Co');
    expect(m).not.toContain('evil.example/phish');
    expect(m).not.toContain('<b>x</b>');
    expect(m).toContain(`<i>${SAFETY_LINE}</i>`);
    expect(m).toContain('Littleton, CO · 2 h ago');
  });

  it('splits into messages of 10', () => {
    const records = Array.from({ length: 25 }, (_, i) => makeRecord({ id: i.toString(16).padStart(12, '0') }));
    expect(telegramMessages(records, { siteUrl: 'https://s' })).toHaveLength(3);
  });

  it('starts a new message rather than slicing when lines would exceed the cap', () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      makeRecord({
        id: i.toString(16).padStart(12, '0'),
        title: `T${i} ` + 'x'.repeat(250),
        company: { slug: 'long', name: 'Long Company Name Incorporated Holdings International Group LLC', domain: 'long.example' },
        location: { raw: 'r'.repeat(150), city: null, state: null, country: 'US', arrangement: 'remote', others: [] },
      }),
    );
    const msgs = telegramMessages(records, { siteUrl: 'https://walkpath.pages.dev', now });
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) {
      expect(m.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_CHARS);
      expect((m.match(/<a href=/g) ?? []).length).toBe((m.match(/<\/a>/g) ?? []).length);
      expect(m).not.toMatch(/<a[^>]*$/);
      expect(m.endsWith(`<i>${SAFETY_LINE}</i>`)).toBe(true);
    }
    const linkCount = msgs.reduce((n, m) => n + (m.match(/<\/a>/g) ?? []).length, 0);
    expect(linkCount).toBe(10);
  });
});

describe('discordPayloads character budget', () => {
  it('splits batches before the embed text total would exceed the message cap', () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      makeRecord({
        id: i.toString(16).padStart(12, '0'),
        title: `T${i} ` + 'y'.repeat(300),
        summary: { text: 'z'.repeat(400), responsibilities: [], qualifications: [], must_have_skills: [], nice_to_have_skills: [], model: 'm', generated_at: '2026-10-09T14:33:02.000Z' },
        location: { raw: 'q'.repeat(300), city: null, state: null, country: 'US', arrangement: 'hybrid', others: [] },
      }),
    );
    const payloads = discordPayloads(records, { siteUrl: 'https://s', now }) as Array<{
      embeds: Array<{ title: string; description: string; fields: Array<{ name: string; value: string }>; footer: { text: string } }>;
    }>;
    const total = (p: (typeof payloads)[number]) =>
      p.embeds.reduce(
        (n, e) => n + e.title.length + e.description.length + e.footer.text.length + e.fields.reduce((m, f) => m + f.name.length + f.value.length, 0),
        0,
      );
    expect(payloads.reduce((n, p) => n + p.embeds.length, 0)).toBe(10);
    for (const p of payloads) {
      expect(total(p)).toBeLessThanOrEqual(DISCORD_MESSAGE_MAX_CHARS);
      for (const e of p.embeds) {
        expect(e.title.length).toBeLessThanOrEqual(256);
        expect(e.fields[0]!.value.length).toBeLessThanOrEqual(110); // ≤100 chars before escaping
        expect(e.fields[0]!.value).not.toMatch(/\\$/); // truncation never cuts an escape
      }
    }
  });
});

function fakeFetch(responses: Array<{ status: number; headers?: Record<string, string>; body?: unknown }>) {
  const calls: Array<{ url: string; body: string }> = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, body: String(init.body) });
    const r = responses.shift() ?? { status: 204 };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  };
  return { fetch, calls };
}

describe('postDiscord / postTelegram', () => {
  it('retries on 429 honouring retry_after and counts results', async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    const { fetch, calls } = fakeFetch([
      { status: 429, body: { retry_after: 1.5 }, headers: { 'retry-after': '2' } },
      { status: 204 },
      { status: 400, body: { message: 'bad' } },
    ]);
    const res = await postDiscord('https://discord.com/api/webhooks/1/x', [{ a: 1 }, { b: 2 }], { fetch, sleep });
    expect(res).toEqual({ sent: 1, failed: 1 });
    expect(calls).toHaveLength(3);
    expect(sleeps[0]).toBe(2000); // header wins when present
    expect(calls[0]!.url).toBe('https://discord.com/api/webhooks/1/x');
  });

  it('treats a JSON retry_after as seconds when there is no header', async () => {
    const sleeps: number[] = [];
    const { fetch } = fakeFetch([{ status: 429, body: { retry_after: 1.5 } }, { status: 204 }]);
    const res = await postDiscord('https://discord.com/api/webhooks/1/x', [{ a: 1 }], {
      fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(res).toEqual({ sent: 1, failed: 0 });
    expect(sleeps[0]).toBe(1500);
  });

  it('gives up after 3 attempts on 5xx', async () => {
    const { fetch, calls } = fakeFetch([{ status: 500 }, { status: 502 }, { status: 503 }]);
    const res = await postDiscord('https://discord.com/api/webhooks/1/x', [{ a: 1 }], { fetch, sleep: async () => {} });
    expect(res).toEqual({ sent: 0, failed: 1 });
    expect(calls).toHaveLength(3);
  });

  it('posts Telegram messages with HTML parse mode and no previews', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 429, body: { ok: false, parameters: { retry_after: 3 } } },
      { status: 200, body: { ok: true } },
    ]);
    const sleeps: number[] = [];
    const res = await postTelegram('123:abc', '@walkpath', ['hello'], {
      fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(res).toEqual({ sent: 1, failed: 0 });
    expect(calls[0]!.url).toBe('https://api.telegram.org/bot123:abc/sendMessage');
    expect(JSON.parse(calls[0]!.body)).toEqual({ chat_id: '@walkpath', text: 'hello', parse_mode: 'HTML', disable_web_page_preview: true });
    expect(sleeps[0]).toBe(3000);
  });

  it('survives a network error', async () => {
    let n = 0;
    const fetch = async (): Promise<Response> => {
      n++;
      throw new Error('ECONNRESET');
    };
    const res = await postTelegram('t', 'c', ['x'], { fetch, sleep: async () => {} });
    expect(res).toEqual({ sent: 0, failed: 1 });
    expect(n).toBe(3);
  });
});
