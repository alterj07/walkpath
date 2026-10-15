/**
 * Oracle Cloud HCM (Oracle Recruiting Cloud) adapter.
 *
 * Every Oracle-hosted career site ("Candidate Experience") is driven by the same undocumented
 * REST resources the site's own front end calls, verified live on 2026-10-10 against Oracle's
 * own site (eeho.fa.us2 / CX_45001), egug.fa.us2 / CX_1 and hdhe.fa.em3 / CX:
 *
 *   GET https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions
 *       ?onlyData=true&expand=requisitionList.secondaryLocations,flexFieldsFacet.values
 *       &finder=findReqs;siteNumber={site},limit=25,offset=N,sortBy=POSTING_DATES_DESC
 *     → { items: [{ TotalJobsCount, Offset, Limit, requisitionList: [{ Id, Title, PostedDate (YYYY-MM-DD),
 *         PostingEndDate, PrimaryLocation, PrimaryLocationCountry, WorkplaceType, WorkplaceTypeCode,
 *         JobFamily, JobFunction, WorkerType, ContractType, JobType, StudyLevel, ShortDescriptionStr,
 *         ExternalQualificationsStr, ExternalResponsibilitiesStr, secondaryLocations: [{ Name, CountryCode }] }] }] }
 *   GET https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails
 *       ?expand=all&onlyData=true&finder=ById;Id={Id},siteNumber={site}
 *     → { items: [{ Id, Title, ExternalDescriptionStr, ExternalQualificationsStr,
 *         ExternalResponsibilitiesStr, CorporateDescriptionStr, ExternalPostedStartDate,
 *         ExternalPostedEndDate, PrimaryLocation, WorkplaceType, ContractType, WorkerType, JobType,
 *         StudyLevel, secondaryLocations, skills, ... }] }
 *
 * The finder names matter: `ByRequisitionId;requisitionId=` (what older write-ups quote) answers
 * HTTP 400 "finder ... is not valid"; `ById;Id=` is what the sites use today. A keyword filter is
 * not used (closure detection needs the full list). Paging is 25 per page by offset; the last page
 * is short and `TotalJobsCount` can change mid-crawl (handled like Workday: re-fetch once).
 *
 * Posture: one concurrent request per host, ≥ 1 s between requests, plain fetch, no evasion; a 403
 * or 429 is the HttpClient's problem (backoff, breaker) and reaches the diff engine as a failed
 * fetch, never closures. Board key is `{host}/{siteNumber}` (e.g. `eeho.fa.us2.oraclecloud.com/CX_45001`).
 */
import { z } from 'zod';
import type { Board } from '../schema/board.ts';
import { JobPostingInputSchema, type JobPostingInput } from '../schema/job.ts';
import { HttpError, type HttpClient, type HttpResponse } from '../http/client.ts';
import { canonicalKey } from '../ids.ts';
import { hostMatches } from '../links.ts';
import { limitsOf, type AdapterPolicy, type SourceAdapter } from './types.ts';
import { parseOrThrow } from './parse.ts';

export const ORACLE_PAGE_SIZE = 25;
export const ORACLE_MAX_PAGES = 200;
/** Wait before retrying a page that came back empty before `TotalJobsCount` was reached. */
export const ORACLE_EMPTY_PAGE_RETRY_MS = 5_000;

export const ORACLE_POLICY: AdapterPolicy = {
  minDelayMs: 1_000,
  maxConcurrencyPerHost: 1,
  allowedHosts: ['*.oraclecloud.com', '*.ocs.oraclecloud.com'],
};

const SecondaryLocationSchema = z.object({
  Name: z.string().nullish(),
  CountryCode: z.string().nullish(),
});

/** One requisition as the list endpoint returns it (unknown keys stripped), plus `detail`. */
export const OracleRawJobSchema = z.object({
  Id: z.union([z.string(), z.number()]).transform((v) => String(v)),
  Title: z.string().min(1),
  PostedDate: z.string().nullish(),
  PostingEndDate: z.string().nullish(),
  PrimaryLocation: z.string().nullish(),
  PrimaryLocationCountry: z.string().nullish(),
  WorkplaceType: z.string().nullish(),
  WorkplaceTypeCode: z.string().nullish(),
  JobFamily: z.string().nullish(),
  JobFunction: z.string().nullish(),
  WorkerType: z.string().nullish(),
  ContractType: z.string().nullish(),
  JobType: z.string().nullish(),
  StudyLevel: z.string().nullish(),
  ShortDescriptionStr: z.string().nullish(),
  ExternalQualificationsStr: z.string().nullish(),
  ExternalResponsibilitiesStr: z.string().nullish(),
  secondaryLocations: z.array(SecondaryLocationSchema).nullish(),
  detail: z
    .object({
      Title: z.string().nullish(),
      ExternalDescriptionStr: z.string().nullish(),
      ExternalQualificationsStr: z.string().nullish(),
      ExternalResponsibilitiesStr: z.string().nullish(),
      ExternalPostedStartDate: z.string().nullish(),
      ExternalPostedEndDate: z.string().nullish(),
      PrimaryLocation: z.string().nullish(),
      WorkplaceType: z.string().nullish(),
      ContractType: z.string().nullish(),
      WorkerType: z.string().nullish(),
      JobType: z.string().nullish(),
      StudyLevel: z.string().nullish(),
      ApplyUrl: z.string().nullish(),
      secondaryLocations: z.array(SecondaryLocationSchema).nullish(),
    })
    .optional(),
});
export type OracleRawJob = z.infer<typeof OracleRawJobSchema>;
export type OracleDetail = NonNullable<OracleRawJob['detail']>;

export const OracleListSchema = z.object({
  items: z
    .array(
      z.object({
        TotalJobsCount: z.number().int().nonnegative().nullish(),
        requisitionList: z.array(OracleRawJobSchema).nullish(),
      }),
    )
    .nullish(),
});

export const OracleDetailResponseSchema = z.object({
  items: z
    .array(
      z.object({
        Title: z.string().nullish(),
        ExternalDescriptionStr: z.string().nullish(),
        ExternalQualificationsStr: z.string().nullish(),
        ExternalResponsibilitiesStr: z.string().nullish(),
        ExternalPostedStartDate: z.string().nullish(),
        ExternalPostedEndDate: z.string().nullish(),
        PrimaryLocation: z.string().nullish(),
        WorkplaceType: z.string().nullish(),
        ContractType: z.string().nullish(),
        WorkerType: z.string().nullish(),
        JobType: z.string().nullish(),
        StudyLevel: z.string().nullish(),
        ApplyUrl: z.string().nullish(),
        secondaryLocations: z.array(SecondaryLocationSchema).nullish(),
      }),
    )
    .nullish(),
});

const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.oraclecloud\.com$/;
const SITE_RE = /^[A-Za-z0-9_-]+$/;

/** `{host}/{siteNumber}` → the pieces of every URL; throws when the board is malformed. */
export function oracleParts(board: Board): { host: string; site: string } {
  const [host, site, ...rest] = board.board_key.split('/');
  if (!host || !site || rest.length > 0 || !HOST_RE.test(host.toLowerCase()) || !SITE_RE.test(site)) {
    throw new Error(`oracle:${board.board_key}: board_key must be "host/siteNumber"`);
  }
  return { host: host.toLowerCase(), site };
}

const REST = 'hcmRestApi/resources/latest';

export function oracleListUrl(board: Board, offset: number, limit: number = ORACLE_PAGE_SIZE): string {
  const { host, site } = oracleParts(board);
  const finder = `findReqs;siteNumber=${encodeURIComponent(site)},limit=${limit},offset=${offset},sortBy=POSTING_DATES_DESC`;
  return `https://${host}/${REST}/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations,flexFieldsFacet.values&finder=${finder}`;
}

export function oracleDetailUrl(board: Board, id: string): string {
  const { host, site } = oracleParts(board);
  return `https://${host}/${REST}/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=${encodeURIComponent(id)},siteNumber=${encodeURIComponent(site)}`;
}

/** The public job page on the career site; also the apply entry point. */
export function oracleHostedUrl(board: Board, id: string): string {
  const { host, site } = oracleParts(board);
  return `https://${host}/hcmUI/CandidateExperience/en/sites/${encodeURIComponent(site)}/job/${encodeURIComponent(id)}`;
}

function jsonBody(res: HttpResponse): unknown {
  if (res.notModified) return null;
  try {
    return JSON.parse(res.body) as unknown;
  } catch {
    throw new HttpError('bad_json', new URL(res.url).hostname, res.status);
  }
}

/** `YYYY-MM-DD` (what the list returns) or a full ISO datetime → UTC ISO string, else null. */
export function parseOracleDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const at = new Date(`${v}T00:00:00Z`);
    return Number.isNaN(at.getTime()) ? null : at.toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const at = new Date(v);
    return Number.isNaN(at.getTime()) ? null : at.toISOString();
  }
  return null;
}

/** Primary location first, then the secondary ones, deduped; prefers the detail response. */
export function oracleLocations(raw: OracleRawJob): string[] {
  const out: string[] = [];
  const push = (s: string | null | undefined) => {
    const v = s?.trim();
    if (v && !out.includes(v)) out.push(v);
  };
  push(raw.detail?.PrimaryLocation ?? raw.PrimaryLocation);
  for (const l of raw.detail?.secondaryLocations ?? raw.secondaryLocations ?? []) push(l.Name);
  return out;
}

export function oracleRemoteFlag(raw: OracleRawJob): boolean | null {
  const type = raw.detail?.WorkplaceType || raw.WorkplaceType || raw.WorkplaceTypeCode;
  if (!type) return null;
  return /\bremote\b/i.test(type) ? true : /\b(hybrid|on-?site)\b/i.test(type) ? false : null;
}

/** Description = external description + qualifications + responsibilities (all HTML fragments). */
export function oracleDescriptionHtml(raw: OracleRawJob): string {
  const parts: string[] = [];
  const d = raw.detail;
  const description = d?.ExternalDescriptionStr?.trim();
  if (description) parts.push(description);
  const responsibilities = (d?.ExternalResponsibilitiesStr ?? raw.ExternalResponsibilitiesStr)?.trim();
  if (responsibilities) parts.push(`<h3>Responsibilities</h3>${responsibilities}`);
  const qualifications = (d?.ExternalQualificationsStr ?? raw.ExternalQualificationsStr)?.trim();
  if (qualifications) parts.push(`<h3>Qualifications</h3>${qualifications}`);
  if (parts.length === 0 && raw.ShortDescriptionStr?.trim()) parts.push(`<p>${raw.ShortDescriptionStr.trim()}</p>`);
  return parts.join('\n');
}

/** Oracle's WorkerType / JobType / ContractType carry "Intern", "Full time", "Student" style values. */
export function oracleEmploymentType(raw: OracleRawJob): string | null {
  const d = raw.detail;
  const candidates = [d?.WorkerType, raw.WorkerType, d?.JobType, raw.JobType, d?.ContractType, raw.ContractType];
  for (const c of candidates) {
    const v = c?.trim();
    if (v) return v;
  }
  return null;
}

export interface OracleAdapterOptions {
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export function createOracleAdapter(opts: OracleAdapterOptions = {}): SourceAdapter<OracleRawJob> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const getPage = async (http: HttpClient, board: Board, offset: number): Promise<unknown> => {
    const res = await http.request({
      url: oracleListUrl(board, offset),
      headers: { accept: 'application/json' },
      allowedHosts: ORACLE_POLICY.allowedHosts,
      limits: limitsOf(ORACLE_POLICY),
    });
    return jsonBody(res);
  };

  return {
    source: 'oracle',
    policy: ORACLE_POLICY,

    async listJobs(board, http) {
      const label = `oracle:${board.board_key}`;
      const jobs: OracleRawJob[] = [];
      const seen = new Set<string>();
      let offset = 0;
      let total: number | null = null;
      let retriedEmpty = false;
      let grewOnce = false;
      for (let page = 0; page < ORACLE_MAX_PAGES; page += 1) {
        const data = await getPage(http, board, offset);
        if (data === null) break; // 304: nothing to add
        const parsed = parseOrThrow(OracleListSchema, data, `${label} list offset ${offset}`);
        const item = parsed.items?.[0];
        const pageTotal = item?.TotalJobsCount ?? 0;
        const postings = item?.requisitionList ?? [];
        if (total !== null && pageTotal > total && !grewOnce) {
          // A requisition was posted mid-crawl and shifted the pages: re-fetch this page once.
          grewOnce = true;
          total = pageTotal;
          page -= 1;
          continue;
        }
        total = pageTotal;
        if (postings.length === 0 && offset < total) {
          // Empty page before the total is a throttle/consistency signal: retry once, then fail
          // the fetch so the diff engine records a failure instead of closing every job.
          if (!retriedEmpty) {
            retriedEmpty = true;
            await sleep(ORACLE_EMPTY_PAGE_RETRY_MS);
            page -= 1;
            continue;
          }
          throw new Error(`${label}: empty page before total`);
        }
        retriedEmpty = false;
        for (const posting of postings) {
          if (seen.has(posting.Id)) continue;
          seen.add(posting.Id);
          jobs.push(posting);
        }
        offset += postings.length;
        if (postings.length < ORACLE_PAGE_SIZE || offset >= total) return jobs;
      }
      if (total !== null && offset < total) throw new Error(`${label}: paging exceeded ${ORACLE_MAX_PAGES} pages`);
      return jobs;
    },

    async fetchDetail(board, raw, http) {
      const res = await http.getJson({
        url: oracleDetailUrl(board, raw.Id),
        headers: { accept: 'application/json' },
        allowedHosts: ORACLE_POLICY.allowedHosts,
        limits: limitsOf(ORACLE_POLICY),
      });
      if (res.data === null) return raw;
      const parsed = parseOrThrow(OracleDetailResponseSchema, res.data, `oracle:${board.board_key} detail`);
      const detail = parsed.items?.[0];
      if (!detail) return raw;
      return { ...raw, detail };
    },

    parsePostedAt(raw) {
      const iso = parseOracleDate(raw.detail?.ExternalPostedStartDate) ?? parseOracleDate(raw.PostedDate);
      return iso ? new Date(iso) : null;
    },

    canonicalKey(raw, board) {
      return canonicalKey('oracle', board.board_key, raw.Id);
    },

    toInput(raw, board, firstSeenAt): JobPostingInput {
      const postedIso = parseOracleDate(raw.detail?.ExternalPostedStartDate) ?? parseOracleDate(raw.PostedDate);
      const hosted = oracleHostedUrl(board, raw.Id);
      let applyUrl = hosted;
      const external = raw.detail?.ApplyUrl?.trim();
      if (external) {
        let host: string | null = null;
        try {
          const parsed = new URL(external);
          host = parsed.protocol === 'https:' ? parsed.hostname : null;
        } catch {
          host = null; // unparseable: keep the constructed URL
        }
        if (host && hostMatches(host, ORACLE_POLICY.allowedHosts)) applyUrl = external;
      }
      return JobPostingInputSchema.parse({
        externalId: raw.Id,
        internalReqId: raw.Id,
        title: raw.detail?.Title?.trim() || raw.Title,
        descriptionHtml: oracleDescriptionHtml(raw),
        locations: oracleLocations(raw),
        employmentType: oracleEmploymentType(raw),
        remoteFlag: oracleRemoteFlag(raw),
        applyUrl,
        hostedUrl: hosted,
        postedAt: postedIso ?? firstSeenAt.toISOString(),
        postedAtSource: postedIso ? 'ATS_FIELD' : 'FIRST_SEEN',
        salary: null,
        department: raw.JobFamily?.trim() || raw.JobFunction?.trim() || null,
        applicationDeadline: parseOracleDate(raw.detail?.ExternalPostedEndDate ?? raw.PostingEndDate),
      });
    },
  };
}

export const oracleAdapter: SourceAdapter<OracleRawJob> = createOracleAdapter();
