import type { JobRecord } from '../schema/job.ts';
import { SAFETY_LINE } from './feeds.ts';

/**
 * Discord and Telegram digests (plan sections 2.4 and 11.7). Messages are built from
 * fields only, with markup escaped, and link only to our job pages. No body is ever
 * logged; the posting helpers return counts.
 */

export const DISCORD_EMBEDS_PER_MESSAGE = 10;
/** Discord allows 6,000 characters across all embeds of one message; keep headroom. */
export const DISCORD_MESSAGE_MAX_CHARS = 5800;
export const TELEGRAM_JOBS_PER_MESSAGE = 10;
/** Telegram allows 4,096 characters per message; keep headroom for the footer. */
export const TELEGRAM_MESSAGE_MAX_CHARS = 4000;

const DISCORD_TITLE_MAX = 256;
const DISCORD_DESCRIPTION_MAX = 300;
const LOCATION_MAX = 100;

export interface AlertOptions {
  siteUrl: string;
  /** Injected clock for stable relative times in tests. */
  now?: Date;
}

export type AlertFetch = (input: string, init: RequestInit) => Promise<Response>;
export type SleepLike = (ms: number) => Promise<void>;

export interface PostOptions {
  fetch?: AlertFetch;
  sleep?: SleepLike;
}

export interface PostResult {
  sent: number;
  failed: number;
}

/** Neutralise Discord markdown and mentions in untrusted text. */
export function escapeDiscord(s: string): string {
  return s.replace(/[\\*_~`|>#[\]()-]/g, (c) => `\\${c}`).replace(/@/g, '@​');
}

/** Escape for Telegram's HTML parse mode. */
export function escapeTelegramHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function jobUrl(siteUrl: string, id: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/job/${id}`;
}

export function relativePosted(iso: string, now: Date): string {
  const diffMs = now.getTime() - new Date(iso).getTime();
  const minutes = Math.max(0, Math.round(diffMs / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** Truncate plain text to `max` characters (before any escaping, so escapes are never cut). */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function locationText(r: JobRecord): string {
  const parts = [r.location.city, r.location.state].filter((p): p is string => !!p);
  let base = parts.length > 0 ? parts.join(', ') : r.location.raw || 'Location not listed';
  if (r.location.others.length > 0) base += ` +${r.location.others.length} more`;
  if (r.location.arrangement === 'remote') base += ' · Remote';
  else if (r.location.arrangement === 'hybrid') base += ' · Hybrid';
  return truncate(base, LOCATION_MAX);
}

interface DiscordEmbed {
  title: string;
  url: string;
  description: string;
  fields: Array<{ name: string; value: string; inline: boolean }>;
  footer: { text: string };
}

function embedChars(e: DiscordEmbed): number {
  return (
    e.title.length +
    e.description.length +
    e.footer.text.length +
    e.fields.reduce((n, f) => n + f.name.length + f.value.length, 0)
  );
}

function buildEmbed(r: JobRecord, opts: AlertOptions, now: Date): DiscordEmbed {
  const title = escapeDiscord(truncate(`${r.title} @ ${r.company.name}`, 120));
  return {
    title: title.length <= DISCORD_TITLE_MAX ? title : truncate(title, DISCORD_TITLE_MAX),
    url: jobUrl(opts.siteUrl, r.id),
    description: escapeDiscord(truncate(r.summary?.text ?? '', 140)).slice(0, DISCORD_DESCRIPTION_MAX),
    fields: [
      { name: 'Location', value: escapeDiscord(locationText(r)) || '—', inline: true },
      { name: 'Posted', value: relativePosted(r.posted_at, now), inline: true },
      ...(r.season ? [{ name: 'Season', value: escapeDiscord(r.season), inline: true }] : []),
    ],
    footer: { text: SAFETY_LINE },
  };
}

/**
 * Discord webhook payloads: at most 10 embeds and DISCORD_MESSAGE_MAX_CHARS of embed
 * text per message, text-only fields, mentions disabled.
 */
export function discordPayloads(records: readonly JobRecord[], opts: AlertOptions): object[] {
  const now = opts.now ?? new Date();
  const payloads: object[] = [];
  let batch: DiscordEmbed[] = [];
  let chars = 0;
  const flush = (): void => {
    if (batch.length === 0) return;
    payloads.push({ username: 'WalkPath', allowed_mentions: { parse: [] }, embeds: batch });
    batch = [];
    chars = 0;
  };
  for (const r of records) {
    const embed = buildEmbed(r, opts, now);
    const n = embedChars(embed);
    if (batch.length >= DISCORD_EMBEDS_PER_MESSAGE || (batch.length > 0 && chars + n > DISCORD_MESSAGE_MAX_CHARS)) flush();
    batch.push(embed);
    chars += n;
  }
  flush();
  return payloads;
}

/**
 * Telegram HTML-mode messages assembled line by line: a new message starts when the
 * next line would push the text past TELEGRAM_MESSAGE_MAX_CHARS, so a built message is
 * never sliced (which could cut an `<a>` tag). Links point only to our job pages.
 */
export function telegramMessages(records: readonly JobRecord[], opts: AlertOptions): string[] {
  const now = opts.now ?? new Date();
  const header = '<b>New US tech internships</b>\n\n';
  const footer = `\n\n<i>${escapeTelegramHtml(SAFETY_LINE)}</i>`;
  const messages: string[] = [];
  let lines: string[] = [];
  let chars = header.length + footer.length;
  const flush = (): void => {
    if (lines.length === 0) return;
    messages.push(`${header}${lines.join('\n')}${footer}`);
    lines = [];
    chars = header.length + footer.length;
  };
  for (const r of records) {
    const href = escapeTelegramHtml(jobUrl(opts.siteUrl, r.id));
    const title = escapeTelegramHtml(truncate(r.title, 200));
    const company = escapeTelegramHtml(truncate(r.company.name, 60));
    const loc = escapeTelegramHtml(locationText(r));
    const line = `• <a href="${href}">${title}</a> — ${company}\n  ${loc} · ${relativePosted(r.posted_at, now)}`;
    const added = line.length + (lines.length > 0 ? 1 : 0);
    if (lines.length >= TELEGRAM_JOBS_PER_MESSAGE || (lines.length > 0 && chars + added > TELEGRAM_MESSAGE_MAX_CHARS)) flush();
    lines.push(line);
    chars += line.length + (lines.length > 1 ? 1 : 0);
  }
  flush();
  return messages;
}

/** Retry-After header, or the JSON `retry_after` both APIs send in seconds. */
function retryAfterMs(res: Response, body: unknown): number | null {
  const header = res.headers.get('retry-after');
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  }
  if (body && typeof body === 'object') {
    const b = body as { retry_after?: unknown; parameters?: { retry_after?: unknown } };
    const ra = b.retry_after ?? b.parameters?.retry_after;
    if (typeof ra === 'number' && Number.isFinite(ra)) return Math.max(0, ra * 1000);
  }
  return null;
}

async function postWithRetry(url: string, body: object, fetchImpl: AlertFetch, sleep: SleepLike): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      if (attempt === 3) return false;
      await sleep(1000 * attempt);
      continue;
    }
    if (res.ok) return true;
    if (res.status === 429 || res.status >= 500) {
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        parsed = null;
      }
      const wait = retryAfterMs(res, parsed) ?? 2000 * attempt;
      if (attempt === 3) return false;
      await sleep(Math.min(wait, 60_000));
      continue;
    }
    return false;
  }
  return false;
}

const defaultSleep: SleepLike = (ms) => new Promise((r) => setTimeout(r, ms));

/** Post each payload to a Discord webhook; ~5 requests / 2 s is the documented ceiling. */
export async function postDiscord(webhookUrl: string, payloads: readonly object[], opts: PostOptions = {}): Promise<PostResult> {
  const fetchImpl = opts.fetch ?? (globalThis.fetch as AlertFetch);
  const sleep = opts.sleep ?? defaultSleep;
  let sent = 0;
  let failed = 0;
  for (const payload of payloads) {
    if (await postWithRetry(webhookUrl, payload, fetchImpl, sleep)) sent++;
    else failed++;
    await sleep(500);
  }
  return { sent, failed };
}

/** Send each message to a Telegram chat/channel via the Bot API (HTML parse mode, no previews). */
export async function postTelegram(botToken: string, chatId: string, messages: readonly string[], opts: PostOptions = {}): Promise<PostResult> {
  const fetchImpl = opts.fetch ?? (globalThis.fetch as AlertFetch);
  const sleep = opts.sleep ?? defaultSleep;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  let sent = 0;
  let failed = 0;
  for (const text of messages) {
    const body = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
    if (await postWithRetry(url, body, fetchImpl, sleep)) sent++;
    else failed++;
    await sleep(3100); // 20 messages per minute per group
  }
  return { sent, failed };
}
