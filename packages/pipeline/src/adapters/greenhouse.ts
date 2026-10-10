import { z } from 'zod';
import { limitsOf, type AdapterPolicy, type SourceAdapter } from './types.ts';
import { parseOrThrow } from './parse.ts';
import type { Board } from '../schema/board.ts';
import { JobPostingInputSchema, type JobPostingInput, type Salary } from '../schema/index.ts';
import type { HttpClient } from '../http/client.ts';
import { canonicalKey } from '../ids.ts';

/**
 * Greenhouse Job Board API (plan sections 3.1, 3.2, 10.2).
 * "Job Board data is publicly available, so authentication is not required."
 *
 * The light list (no `content`) is fetched every poll; the single-job endpoint, which
 * carries the description, is fetched only for new ids or a changed `updated_at`
 * (plan 3.3 item 5), which cuts bandwidth by roughly 20x.
 */

export const GREENHOUSE_API_HOST = 'boards-api.greenhouse.io';

export const GREENHOUSE_POLICY: AdapterPolicy = {
  // Measured 2026-10-10: at 20 concurrent requests with no delay, boards-api.greenhouse.io
  // blocked the crawler (403 on every list and detail call) about 70 s and ~330 boards in.
  // ~4 requests/s keeps us well under that; the host circuit breaker in HttpClient stops
  // the run for this host if it ever blocks again (plan 10.3).
  minDelayMs: 250,
  maxConcurrencyPerHost: 4,
  // Apply URLs legitimately live on these hosts; the diff engine also allows the company domain.
  allowedHosts: [
    'boards-api.greenhouse.io',
    'boards.greenhouse.io',
    'job-boards.greenhouse.io',
    'job-boards.eu.greenhouse.io',
    'boards.eu.greenhouse.io',
  ],
};

/* ---------- Raw payload schemas (zod at the boundary; unknown keys are stripped) ---------- */

const PayInputRangeSchema = z.object({
  min_cents: z.number().nullish(),
  max_cents: z.number().nullish(),
  currency_type: z.string().nullish(),
  title: z.string().nullish(),
});

/**
 * `value` depends on the field type: a string for single selects, an array for multi
 * selects, a boolean for yes/no, `{unit, amount}` for currency, null when unset. Kept
 * open so an unexpected type never fails the whole board.
 */
const MetadataSchema = z.object({
  name: z.string().nullish(),
  value: z.unknown().optional(),
});

const NamedSchema = z.object({ name: z.string().nullish() });

export const GreenhouseRawJobSchema = z.object({
  id: z.number().int(),
  /** Stable across reposts; the list exposes it so repost detection needs no detail call. */
  internal_job_id: z.number().int().nullish(),
  requisition_id: z.union([z.string(), z.number()]).nullish(),
  title: z.string().min(1),
  absolute_url: z.string(),
  location: z.object({ name: z.string().nullish() }).nullish(),
  /** Present on live list responses although undocumented; the employer's publish time. */
  first_published: z.string().nullish(),
  /** Documented; changes on any edit. */
  updated_at: z.string().nullish(),
  application_deadline: z.string().nullish(),
  company_name: z.string().nullish(),
  metadata: z.array(MetadataSchema).nullish(),
  pay_input_ranges: z.array(PayInputRangeSchema).nullish(),
  /** Only on the single-job endpoint: HTML with entities escaped once (`&lt;p&gt;`). */
  content: z.string().nullish(),
  departments: z.array(NamedSchema).nullish(),
  offices: z.array(NamedSchema.extend({ location: z.string().nullish() })).nullish(),
});
export type GreenhouseRawJob = z.infer<typeof GreenhouseRawJobSchema>;

export const GreenhouseListSchema = z.object({
  jobs: z.array(GreenhouseRawJobSchema),
  meta: z.object({ total: z.number().nullish() }).nullish(),
});

/* ---------- Helpers ---------- */

/** Decode exactly one level of HTML entities: Greenhouse escapes the description HTML once. */
export function decodeEntitiesOnce(text: string): string {
  return text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(lt|gt|amp|quot|apos));/gi, (match, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
    if (hex !== undefined) return safeFromCodePoint(Number.parseInt(hex, 16), match);
    if (dec !== undefined) return safeFromCodePoint(Number.parseInt(dec, 10), match);
    switch (named?.toLowerCase()) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        return match;
    }
  });
}

function safeFromCodePoint(code: number, fallback: string): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/**
 * Greenhouse joins multiple offices into one string with `;`, `|`, `•` or ` & `.
 * Commas are not separators ("New York, Seattle, South San Francisco HQ" is one office label).
 */
export function parseGreenhouseLocation(name: string | null | undefined): string[] {
  if (!name) return [];
  const parts = name
    .split(/\s*[;|•]\s*|\s+&\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return [...new Set(parts)];
}

/** String, number, boolean and string/number arrays are readable; objects and the rest are ignored. */
function metadataText(v: unknown): string | null {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v).trim() || null;
  if (Array.isArray(v)) {
    const text = v
      .filter((x): x is string | number => typeof x === 'string' || typeof x === 'number')
      .map(String)
      .join(', ')
      .trim();
    return text || null;
  }
  return null;
}

function metadataValue(raw: GreenhouseRawJob, pattern: RegExp): string | null {
  for (const entry of raw.metadata ?? []) {
    if (!entry.name || !pattern.test(entry.name)) continue;
    const text = metadataText(entry.value);
    if (text) return text;
  }
  return null;
}

function toIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function periodFromRange(title: string | null | undefined, max: number | null): Salary['period'] {
  const t = title ?? '';
  if (/\b(hour|hourly|hr)\b/i.test(t)) return 'hour';
  if (/\b(annual|annually|year|yearly|salary|yr)\b/i.test(t)) return 'year';
  if (/\bmonth(ly)?\b/i.test(t)) return 'month';
  if (/\bweek(ly)?\b/i.test(t)) return 'week';
  if (max !== null) {
    if (max <= 500) return 'hour';
    if (max >= 10_000) return 'year';
  }
  return null;
}

/** Collapse pay-transparency ranges (one per zone) into a single min..max. */
export function parseGreenhouseSalary(raw: GreenhouseRawJob): Salary | null {
  const ranges = (raw.pay_input_ranges ?? []).filter((r) => r.min_cents != null || r.max_cents != null);
  if (ranges.length === 0) return null;
  const mins = ranges.map((r) => r.min_cents).filter((v): v is number => typeof v === 'number' && v >= 0);
  const maxs = ranges.map((r) => r.max_cents).filter((v): v is number => typeof v === 'number' && v >= 0);
  const min = mins.length ? Math.min(...mins) / 100 : null;
  const max = maxs.length ? Math.max(...maxs) / 100 : null;
  const currencyRaw = ranges[0]?.currency_type?.trim().toUpperCase();
  const currency = currencyRaw && /^[A-Z]{3}$/.test(currencyRaw) ? currencyRaw : 'USD';
  return { min, max, currency, period: periodFromRange(ranges[0]?.title, max ?? min) };
}

function remoteFlag(raw: GreenhouseRawJob): boolean | null {
  const locationType = metadataValue(raw, /location type|work(place)? type|work arrangement/i);
  if (locationType) {
    if (/remote/i.test(locationType)) return true;
    if (/on-?site|in[- ]person|hybrid/i.test(locationType)) return false;
  }
  if (/\bremote\b/i.test(raw.title) || /\bremote\b/i.test(raw.location?.name ?? '')) return true;
  return null;
}

function listUrl(board: Board): string {
  return `https://${GREENHOUSE_API_HOST}/v1/boards/${encodeURIComponent(board.board_key)}/jobs?pay_transparency=true`;
}

function detailUrl(board: Board, id: number): string {
  return `https://${GREENHOUSE_API_HOST}/v1/boards/${encodeURIComponent(board.board_key)}/jobs/${id}?questions=false&pay_transparency=true`;
}

export interface GreenhouseListResult {
  /** null on 304 (nothing changed since the validators the caller passed). */
  jobs: GreenhouseRawJob[] | null;
  notModified: boolean;
  etag: string | null;
  lastModified: string | null;
}

/**
 * Light list with optional conditional-GET validators (Greenhouse sends a weak ETag).
 * Exposed for the crawl job; `listJobs` is the plain adapter entry point.
 */
export async function fetchGreenhouseList(
  board: Board,
  http: HttpClient,
  validators: { etag?: string | null; lastModified?: string | null } = {},
): Promise<GreenhouseListResult> {
  const res = await http.getJson({
    url: listUrl(board),
    allowedHosts: GREENHOUSE_POLICY.allowedHosts,
    limits: limitsOf(GREENHOUSE_POLICY),
    etag: validators.etag ?? null,
    lastModified: validators.lastModified ?? null,
  });
  if (res.notModified) return { jobs: null, notModified: true, etag: res.etag, lastModified: res.lastModified };
  const parsed = parseOrThrow(GreenhouseListSchema, res.data, `greenhouse:${board.board_key} list`);
  return { jobs: parsed.jobs, notModified: false, etag: res.etag, lastModified: res.lastModified };
}

/** first_published → updated_at → null (plan section 3.2). */
export function parseGreenhousePostedAt(raw: GreenhouseRawJob): Date | null {
  for (const candidate of [raw.first_published, raw.updated_at]) {
    if (!candidate) continue;
    const ms = Date.parse(candidate);
    if (!Number.isNaN(ms)) return new Date(ms);
  }
  return null;
}

/* ---------- Adapter ---------- */

export const greenhouseAdapter: SourceAdapter<GreenhouseRawJob> = {
  source: 'greenhouse',
  policy: GREENHOUSE_POLICY,

  async listJobs(board, http) {
    const result = await fetchGreenhouseList(board, http);
    return result.jobs ?? [];
  },

  async fetchDetail(board, raw, http) {
    const res = await http.getJson({
      url: detailUrl(board, raw.id),
      allowedHosts: GREENHOUSE_POLICY.allowedHosts,
      limits: limitsOf(GREENHOUSE_POLICY),
    });
    if (res.notModified) return raw;
    const detail = parseOrThrow(GreenhouseRawJobSchema, res.data, `greenhouse:${board.board_key} job`);
    // The list fields are authoritative for identity; the detail adds content, departments, offices.
    return { ...raw, ...detail, id: raw.id };
  },

  parsePostedAt(raw) {
    return parseGreenhousePostedAt(raw);
  },

  canonicalKey(raw, board) {
    return canonicalKey('greenhouse', board.board_key, String(raw.id));
  },

  toInput(raw, _board, firstSeenAt): JobPostingInput {
    const posted = parseGreenhousePostedAt(raw);
    const content = raw.content ?? '';
    return JobPostingInputSchema.parse({
      externalId: String(raw.id),
      internalReqId: raw.internal_job_id != null ? String(raw.internal_job_id) : null,
      title: raw.title.trim(),
      descriptionHtml: content ? decodeEntitiesOnce(content) : '',
      locations: parseGreenhouseLocation(raw.location?.name),
      employmentType: metadataValue(raw, /employment|job type|req type|position type/i),
      remoteFlag: remoteFlag(raw),
      applyUrl: raw.absolute_url,
      hostedUrl: raw.absolute_url,
      postedAt: posted ? posted.toISOString() : firstSeenAt.toISOString(),
      postedAtSource: posted ? 'ATS_FIELD' : 'FIRST_SEEN',
      salary: parseGreenhouseSalary(raw),
      department: raw.departments?.[0]?.name?.trim() || null,
      applicationDeadline: toIso(raw.application_deadline),
    });
  },
};
