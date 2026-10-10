/**
 * Workday adapter (plan sections 3.1, 3.2, 4.4, 10.2).
 *
 * Workday has no public API. Every tenant's career site is driven by the undocumented,
 * community-reverse-engineered `cxs` JSON endpoint:
 *
 *   POST https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
 *        body {"appliedFacets":{},"limit":20,"offset":N,"searchText":""}
 *   GET  https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}{externalPath}
 *
 * Posture (10.2): one concurrent request per tenant, at least 2 s between requests, a plain
 * fetch with our fixed User-Agent, no fingerprint spoofing, stop on 403 (the HttpClient
 * backs off and the diff engine records a failed fetch, never closures). `limit` above 20
 * returns an empty array rather than an error, and paging too fast silently drops pages:
 * an empty page before `total` is reached is therefore a throttle signal, not end-of-list.
 *
 * Timestamps (3.2): the list only says "Posted Today" / "Posted 3 Days Ago" / "Posted 30+
 * Days Ago", so `posted_at` is date precision (`WORKDAY_TEXT`) or our first-seen time.
 * The detail response carries `startDate` (YYYY-MM-DD); it is kept on the raw job for a
 * future season parser but JobPostingInput has no slot for it yet.
 */
import { z } from 'zod';
import type { Board } from '../schema/board.ts';
import { JobPostingInputSchema, type JobPostingInput } from '../schema/job.ts';
import { HttpError, type HttpClient, type HttpResponse } from '../http/client.ts';
import { canonicalKey } from '../ids.ts';
import { hostMatches } from '../links.ts';
import { limitsOf, type AdapterPolicy, type SourceAdapter } from './types.ts';
import { parseOrThrow } from './parse.ts';

export const WORKDAY_PAGE_SIZE = 20;
export const WORKDAY_MAX_PAGES = 300;
/** Wait before retrying a page that came back empty before `total` was reached. */
export const WORKDAY_EMPTY_PAGE_RETRY_MS = 5_000;

export const WORKDAY_POLICY: AdapterPolicy = {
  minDelayMs: 2_000,
  maxConcurrencyPerHost: 1,
  allowedHosts: ['*.myworkdayjobs.com', '*.myworkdaysite.com'],
  hostsPerBoard: true,
};

const DAY_MS = 86_400_000;

/** Fields the detail endpoint adds (jobPostingInfo). Unknown keys are stripped. */
export const WorkdayDetailSchema = z.object({
  id: z.string().nullish(),
  title: z.string().nullish(),
  jobDescription: z.string().nullish(),
  location: z.string().nullish(),
  additionalLocations: z.array(z.string()).nullish(),
  postedOn: z.string().nullish(),
  /** YYYY-MM-DD; the requisition's start date. Not mapped into JobPostingInput yet. */
  startDate: z.string().nullish(),
  /** YYYY-MM-DD; when the posting closes. */
  endDate: z.string().nullish(),
  timeType: z.string().nullish(),
  jobReqId: z.string().nullish(),
  remoteType: z.string().nullish(),
  externalUrl: z.string().nullish(),
  country: z.object({ descriptor: z.string().nullish(), alpha2Code: z.string().nullish() }).nullish(),
});
export type WorkdayDetail = z.infer<typeof WorkdayDetailSchema>;

export const WorkdayDetailResponseSchema = z.object({
  jobPostingInfo: WorkdayDetailSchema,
  hiringOrganization: z.object({ name: z.string().nullish() }).nullish(),
});

/** One posting as the list endpoint returns it, plus `detail` after fetchDetail. */
export const WorkdayRawJobSchema = z.object({
  title: z.string().min(1),
  externalPath: z.string().min(1),
  locationsText: z.string().nullish(),
  postedOn: z.string().nullish(),
  bulletFields: z.array(z.string()).nullish(),
  timeType: z.string().nullish(),
  remoteType: z.string().nullish(),
  detail: WorkdayDetailSchema.optional(),
});
export type WorkdayRawJob = z.infer<typeof WorkdayRawJobSchema>;

export const WorkdayListSchema = z.object({
  total: z.number().int().nonnegative(),
  jobPostings: z.array(WorkdayRawJobSchema).nullish(),
});

/** `tenant/site` + wd → the pieces of every URL; throws when the board is malformed. */
export function workdayParts(board: Board): { tenant: string; site: string; host: string } {
  const [tenant, site, ...rest] = board.board_key.split('/');
  if (!tenant || !site || rest.length > 0 || !/^[A-Za-z0-9_-]+$/.test(tenant) || !/^[A-Za-z0-9_.-]+$/.test(site)) {
    throw new Error(`workday:${board.board_key}: board_key must be "tenant/site"`);
  }
  if (board.wd === undefined) throw new Error(`workday:${board.board_key}: wd column is required`);
  return { tenant, site, host: `${tenant.toLowerCase()}.wd${board.wd}.myworkdayjobs.com` };
}

export function workdayListUrl(board: Board): string {
  const { tenant, site, host } = workdayParts(board);
  return `https://${host}/wday/cxs/${tenant}/${site}/jobs`;
}

export function workdayDetailUrl(board: Board, externalPath: string): string {
  const { tenant, site, host } = workdayParts(board);
  return `https://${host}/wday/cxs/${tenant}/${site}${externalPath}`;
}

export function workdayHostedUrl(board: Board, externalPath: string): string {
  const { site, host } = workdayParts(board);
  return `https://${host}/${site}${externalPath}`;
}

/**
 * The trailing `_<REQ>` segment of the external path, e.g.
 * `/job/US-CA-Santa-Clara/Software-Intern_JR1988888` → `JR1988888`,
 * `/job/GBR---Gosport-UK/Commercial-Intern_JR2026522032-1` → `JR2026522032-1`
 * (the `-1` suffix distinguishes multi-postings of one requisition; keep it).
 * Falls back to the whole path when there is no underscore segment.
 */
export function workdayExternalId(externalPath: string): string {
  const last = externalPath.split('/').pop() ?? '';
  const idx = last.lastIndexOf('_');
  const tail = idx >= 0 ? last.slice(idx + 1) : '';
  return tail || externalPath;
}

/** The requisition id without a multi-posting suffix (bulletFields[0] when present). */
export function workdayReqId(raw: WorkdayRawJob): string | null {
  const bullet = raw.bulletFields?.find((b) => /^[A-Za-z]*\d+$/.test(b));
  if (bullet) return bullet;
  if (raw.detail?.jobReqId) return raw.detail.jobReqId;
  const id = workdayExternalId(raw.externalPath);
  if (id === raw.externalPath) return null;
  return id.replace(/-\d+$/, '');
}

function jsonBody(res: HttpResponse): unknown {
  if (res.notModified) return null;
  try {
    return JSON.parse(res.body) as unknown;
  } catch {
    throw new HttpError('bad_json', new URL(res.url).hostname, res.status);
  }
}

function utcMidnight(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * Plan 3.2 Workday rule, on the English `postedOn` phrases. The phrases are relative to
 * NOW (the run start), not to when we first saw the posting, so `now` must be passed on
 * every run or `posted_at` would walk backwards one day per run for existing jobs.
 *   "Posted Today"         → firstSeenAt when it falls on today (UTC), else today 00:00Z
 *   "Posted Yesterday"     → today − 1 day at 00:00Z
 *   "Posted N Days Ago"    → today − N days at 00:00Z (date precision)
 *   "Posted 30+ Days Ago"  → today − 30 days at 00:00Z
 *   anything else (localized, missing) → null → the caller uses first_seen_at
 */
export function parseWorkdayPostedOn(text: string | null | undefined, firstSeenAt: Date, now: Date = firstSeenAt): Date | null {
  if (!text) return null;
  const t = text.trim().toLowerCase();
  const today = utcMidnight(now);
  if (/^posted\s+today$/.test(t)) {
    return utcMidnight(firstSeenAt).getTime() === today.getTime() ? new Date(firstSeenAt.getTime()) : today;
  }
  if (/^posted\s+yesterday$/.test(t)) return new Date(today.getTime() - DAY_MS);
  const m = /^posted\s+(\d{1,3})(\+?)\s+days?\s+ago$/.exec(t);
  if (!m) return null;
  const days = Number(m[1]);
  if (!Number.isFinite(days)) return null;
  return new Date(today.getTime() - days * DAY_MS);
}

function parseIsoDate(value: string | null | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const at = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** Locations: detail `location` + `additionalLocations`, else the list text split on ` | ` / `; `. */
export function workdayLocations(raw: WorkdayRawJob): string[] {
  const out: string[] = [];
  const push = (s: string | null | undefined) => {
    const v = s?.trim();
    if (v && !out.includes(v)) out.push(v);
  };
  if (raw.detail?.location || raw.detail?.additionalLocations?.length) {
    push(raw.detail.location);
    for (const l of raw.detail.additionalLocations ?? []) push(l);
  } else if (raw.locationsText) {
    for (const part of raw.locationsText.split(/\s*(?:\||;)\s*/)) push(part);
  }
  return out;
}

export function workdayRemoteFlag(raw: WorkdayRawJob): boolean | null {
  const type = raw.detail?.remoteType ?? raw.remoteType;
  if (!type) return null;
  return /\bremote\b/i.test(type) ? true : /\b(hybrid|on-?site)\b/i.test(type) ? false : null;
}

export interface WorkdayAdapterOptions {
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export function createWorkdayAdapter(opts: WorkdayAdapterOptions = {}): SourceAdapter<WorkdayRawJob> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // HttpClient.getJson is GET-only; the list endpoint is a POST, so the body is parsed
  // here under the same rule: a JSON SyntaxError never reaches a (public) log.
  const postPage = async (http: HttpClient, url: string, offset: number): Promise<unknown> => {
    const res = await http.request({
      url,
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ appliedFacets: {}, limit: WORKDAY_PAGE_SIZE, offset, searchText: '' }),
      allowedHosts: WORKDAY_POLICY.allowedHosts,
      limits: limitsOf(WORKDAY_POLICY),
    });
    return jsonBody(res);
  };

  return {
    source: 'workday',
    policy: WORKDAY_POLICY,

    async listJobs(board, http) {
      const url = workdayListUrl(board);
      const label = `workday:${board.board_key}`;
      const jobs: WorkdayRawJob[] = [];
      const seen = new Set<string>();
      let offset = 0;
      let total: number | null = null;
      let retriedEmpty = false;
      let grewOnce = false;
      for (let page = 0; page < WORKDAY_MAX_PAGES; page += 1) {
        const data = await postPage(http, url, offset);
        if (data === null) break; // 304: nothing to add
        const parsed = parseOrThrow(WorkdayListSchema, data, `${label} list offset ${offset}`);
        if (total !== null && parsed.total > total && !grewOnce) {
          // A posting was added mid-crawl and shifted the pages: re-fetch this page once so
          // nothing is missed; the seen set drops the duplicates.
          grewOnce = true;
          total = parsed.total;
          page -= 1;
          continue;
        }
        total = parsed.total;
        const postings = parsed.jobPostings ?? [];
        if (postings.length === 0 && offset < total) {
          // Throttle signal (fast paging silently drops pages): retry once, then fail the fetch.
          if (!retriedEmpty) {
            retriedEmpty = true;
            await sleep(WORKDAY_EMPTY_PAGE_RETRY_MS);
            page -= 1;
            continue;
          }
          throw new Error(`${label}: empty page before total`);
        }
        retriedEmpty = false;
        for (const posting of postings) {
          const id = workdayExternalId(posting.externalPath);
          if (seen.has(id)) continue;
          seen.add(id);
          jobs.push(posting);
        }
        offset += postings.length;
        if (postings.length < WORKDAY_PAGE_SIZE || offset >= total) return jobs;
      }
      if (total !== null && offset < total) throw new Error(`${label}: paging exceeded ${WORKDAY_MAX_PAGES} pages`);
      return jobs;
    },

    async fetchDetail(board, raw, http) {
      const res = await http.getJson({
        url: workdayDetailUrl(board, raw.externalPath),
        headers: { accept: 'application/json' },
        allowedHosts: WORKDAY_POLICY.allowedHosts,
        limits: limitsOf(WORKDAY_POLICY),
      });
      if (res.data === null) return raw;
      const parsed = parseOrThrow(WorkdayDetailResponseSchema, res.data, `workday:${board.board_key} detail`);
      return { ...raw, detail: parsed.jobPostingInfo };
    },

    parsePostedAt(raw, firstSeenAt, now) {
      return parseWorkdayPostedOn(raw.detail?.postedOn ?? raw.postedOn, firstSeenAt, now ?? firstSeenAt);
    },

    canonicalKey(raw, board) {
      return canonicalKey('workday', board.board_key, workdayExternalId(raw.externalPath));
    },

    toInput(raw, board, firstSeenAt, now): JobPostingInput {
      const postedAt = parseWorkdayPostedOn(raw.detail?.postedOn ?? raw.postedOn, firstSeenAt, now ?? firstSeenAt);
      const hosted = workdayHostedUrl(board, raw.externalPath);
      const external = raw.detail?.externalUrl?.trim();
      let applyUrl = hosted;
      if (external) {
        let host: string | null = null;
        try {
          const parsed = new URL(external);
          host = parsed.protocol === 'https:' ? parsed.hostname : null;
        } catch {
          host = null; // unparseable: keep the constructed URL
        }
        if (host && hostMatches(host, WORKDAY_POLICY.allowedHosts)) applyUrl = external;
      }
      return JobPostingInputSchema.parse({
        externalId: workdayExternalId(raw.externalPath),
        internalReqId: workdayReqId(raw),
        title: raw.detail?.title?.trim() || raw.title,
        descriptionHtml: raw.detail?.jobDescription ?? '',
        locations: workdayLocations(raw),
        employmentType: raw.detail?.timeType ?? raw.timeType ?? null,
        remoteFlag: workdayRemoteFlag(raw),
        applyUrl,
        hostedUrl: hosted,
        postedAt: postedAt ? postedAt.toISOString() : firstSeenAt.toISOString(),
        postedAtSource: postedAt ? 'WORKDAY_TEXT' : 'FIRST_SEEN',
        salary: null,
        department: null,
        applicationDeadline: parseIsoDate(raw.detail?.endDate),
      });
    },
  };
}

export const workdayAdapter: SourceAdapter<WorkdayRawJob> = createWorkdayAdapter();
