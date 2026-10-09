import { z } from 'zod';
import type { HttpClient } from '../http/client.ts';
import { canonicalKey } from '../ids.ts';
import type { Board } from '../schema/board.ts';
import { JobPostingInputSchema, type JobPostingInput, type Salary } from '../schema/index.ts';
import { limitsOf, type AdapterPolicy, type SourceAdapter } from './types.ts';
import { parseOrThrow } from './parse.ts';

/**
 * Lever Postings API (plan section 3.1): `GET https://api.lever.co/v0/postings/{site}?mode=json`,
 * unauthenticated, paged with `skip`/`limit`. Lever's README says published postings "may be
 * scraped by third parties"; its robots.txt asks for `Crawl-delay: 1`, which `minDelayMs`
 * honours. The list carries the full description, so there is no detail call.
 *
 * EU boards: the registry writes `board_key` as `eu:{site}` for boards hosted on
 * jobs.eu.lever.co; everything else is the US host.
 */
export const LEVER_PAGE_SIZE = 100;
/** 100 pages × 100 postings; no real board is that big, so past it the host is ignoring `skip`. */
export const LEVER_MAX_PAGES = 100;
export const LEVER_HOSTS = ['api.lever.co', 'api.eu.lever.co', 'jobs.lever.co', 'jobs.eu.lever.co'] as const;

export const LEVER_POLICY: AdapterPolicy = {
  minDelayMs: 1000,
  maxConcurrencyPerHost: 10,
  allowedHosts: LEVER_HOSTS,
};

const nullableString = z.string().nullish();

export const LeverCategoriesSchema = z.object({
  commitment: nullableString,
  department: nullableString,
  location: nullableString,
  team: nullableString,
  level: nullableString,
  allLocations: z.array(z.string()).nullish(),
});

export const LeverSalaryRangeSchema = z.object({
  min: z.number().nullish(),
  max: z.number().nullish(),
  currency: nullableString,
  interval: nullableString,
});

export const LeverListSchema = z.object({
  text: z.string(),
  content: z.string().nullish(),
});

/** One posting as the list endpoint returns it; unknown keys are stripped, nulls tolerated. */
export const LeverRawJobSchema = z.object({
    id: z.string().min(1),
    text: z.string().min(1),
    categories: LeverCategoriesSchema.nullish(),
    createdAt: z.number().nullish(),
    country: nullableString,
    workplaceType: nullableString,
    opening: nullableString,
    description: nullableString,
    additional: nullableString,
    lists: z.array(LeverListSchema).nullish(),
    hostedUrl: nullableString,
    applyUrl: z.string().min(1),
    salaryRange: LeverSalaryRangeSchema.nullish(),
});
export type LeverRawJob = z.infer<typeof LeverRawJobSchema>;

export const LeverPageSchema = z.array(LeverRawJobSchema);

/** `eu:{site}` → EU host; otherwise the US host. */
export function leverApiBase(boardKey: string): { host: string; site: string } {
  const m = /^eu:(.+)$/.exec(boardKey);
  return m ? { host: 'api.eu.lever.co', site: m[1]! } : { host: 'api.lever.co', site: boardKey };
}

export function leverPageUrl(boardKey: string, skip: number, limit = LEVER_PAGE_SIZE): string {
  const { host, site } = leverApiBase(boardKey);
  return `https://${host}/v0/postings/${encodeURIComponent(site)}?mode=json&skip=${skip}&limit=${limit}`;
}

/** Lever salary intervals seen live: per-year-salary, per-month-salary, per-hour-wage. */
export function leverSalaryPeriod(interval: string | null | undefined): Salary['period'] {
  switch (interval) {
    case 'per-year-salary':
      return 'year';
    case 'per-month-salary':
      return 'month';
    case 'per-week-wage':
      return 'week';
    case 'per-day-wage':
      return 'day';
    case 'per-hour-wage':
      return 'hour';
    default:
      return null;
  }
}

function toSalary(raw: LeverRawJob): Salary | null {
  const r = raw.salaryRange;
  if (!r) return null;
  const min = typeof r.min === 'number' && r.min >= 0 ? r.min : null;
  const max = typeof r.max === 'number' && r.max >= 0 ? r.max : null;
  if (min === null && max === null) return null;
  const currency = r.currency && /^[A-Za-z]{3}$/.test(r.currency) ? r.currency.toUpperCase() : 'USD';
  return { min, max, currency, period: leverSalaryPeriod(r.interval) };
}

/** opening + description + each list as `<h3>` + content + additional; all are HTML fragments. */
export function leverDescriptionHtml(raw: LeverRawJob): string {
  const parts: string[] = [];
  if (raw.opening) parts.push(raw.opening);
  if (raw.description) parts.push(raw.description);
  for (const list of raw.lists ?? []) {
    parts.push(`<h3>${list.text}</h3>${list.content ?? ''}`);
  }
  if (raw.additional) parts.push(raw.additional);
  return parts.join('\n');
}

function locationsOf(raw: LeverRawJob): string[] {
  const all = (raw.categories?.allLocations ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
  if (all.length > 0) return all;
  const one = raw.categories?.location?.trim();
  return one ? [one] : [];
}

function remoteFlagOf(raw: LeverRawJob): boolean | null {
  switch (raw.workplaceType) {
    case 'remote':
      return true;
    case 'onsite':
    case 'hybrid':
      return false;
    default:
      return null;
  }
}

/** `createdAt` is epoch milliseconds (undocumented, present on every live posting). */
export function parseLeverPostedAt(raw: LeverRawJob): Date | null {
  if (typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt) || raw.createdAt <= 0) return null;
  return new Date(raw.createdAt);
}

export const leverAdapter: SourceAdapter<LeverRawJob> = {
  source: 'lever',
  policy: LEVER_POLICY,

  async listJobs(board: Board, http: HttpClient): Promise<LeverRawJob[]> {
    const jobs: LeverRawJob[] = [];
    const seen = new Set<string>();
    for (let page = 0; ; page += 1) {
      if (page >= LEVER_MAX_PAGES) throw new Error(`lever:${board.board_key}: paging exceeded ${LEVER_MAX_PAGES} pages`);
      const res = await http.getJson({
        url: leverPageUrl(board.board_key, page * LEVER_PAGE_SIZE),
        allowedHosts: LEVER_HOSTS,
        limits: limitsOf(LEVER_POLICY),
      });
      // A conditional GET is never sent for list pages, so 304 here means a broken upstream.
      if (res.notModified) break;
      const rows = parseOrThrow(LeverPageSchema, res.data, `lever:${board.board_key} page ${page}`);
      let added = 0;
      for (const job of rows) {
        // Lever's paging is by offset; a posting added mid-crawl can shift one onto two pages.
        if (seen.has(job.id)) continue;
        seen.add(job.id);
        jobs.push(job);
        added += 1;
      }
      // A full page that adds nothing new means the host is ignoring `skip`; stop rather than loop.
      if (rows.length < LEVER_PAGE_SIZE || added === 0) break;
    }
    return jobs;
  },

  parsePostedAt(raw: LeverRawJob): Date | null {
    return parseLeverPostedAt(raw);
  },

  canonicalKey(raw: LeverRawJob, board: Board): string {
    return canonicalKey('lever', board.board_key, raw.id);
  },

  toInput(raw: LeverRawJob, _board: Board, firstSeenAt: Date): JobPostingInput {
    const posted = parseLeverPostedAt(raw);
    return JobPostingInputSchema.parse({
      externalId: raw.id,
      internalReqId: null,
      title: raw.text,
      descriptionHtml: leverDescriptionHtml(raw),
      locations: locationsOf(raw),
      employmentType: raw.categories?.commitment ?? null,
      remoteFlag: remoteFlagOf(raw),
      applyUrl: raw.applyUrl,
      hostedUrl: raw.hostedUrl ?? null,
      postedAt: (posted ?? firstSeenAt).toISOString(),
      postedAtSource: posted ? 'ATS_FIELD' : 'FIRST_SEEN',
      salary: toSalary(raw),
      department: raw.categories?.department ?? raw.categories?.team ?? null,
      applicationDeadline: null,
    });
  },
};
