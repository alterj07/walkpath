import { z } from 'zod';
import type { Board } from '../schema/board.ts';
import { JobPostingInputSchema, type JobPostingInput, type Salary } from '../schema/index.ts';
import { HttpError, type HttpClient } from '../http/client.ts';
import { canonicalKey } from '../ids.ts';
import { limitsOf, type AdapterPolicy, type SourceAdapter } from './types.ts';
import { parseOrThrow } from './parse.ts';

/**
 * Workable public job-board widget (plan sections 3.1, 3.2, 4.3, 10.2).
 *
 * Live behaviour (observed 2026-10-09): `https://www.workable.com/api/accounts/{sub}?details=true`
 * answers 302 for every subdomain, known or not, to
 * `https://apply.workable.com/api/v1/widget/accounts/{sub}?details=true`. The widget endpoint
 * is the one that carries the data: 200 + JSON for a customer, 404 `text/plain` for an unknown
 * account. We call the widget endpoint directly to save a hop; the `www` host stays in the
 * allowlist so a redirect either way remains on-host.
 *
 * Payload: `{ name, description, jobs: [...] }`. Each job has title, shortcode, code
 * (''|null|requisition code), employment_type (''|'Full-time'|'Temporary'|...), telecommuting
 * (boolean), department (nullable), url, shortlink, application_url, published_on (YYYY-MM-DD),
 * created_at (YYYY-MM-DD), country, city, state, education/experience/function/industry
 * (nullable strings), locations[{country, countryCode, city, region, hidden}], description
 * (HTML). No `requirements`/`benefits` keys and no `workplace_type`/salary in the widget payload.
 */

/** Every Workable host is a subdomain (apply., www., jobs.); the wildcard excludes the bare apex. */
export const WORKABLE_HOSTS = ['*.workable.com'] as const;

export const WORKABLE_POLICY: AdapterPolicy = {
  minDelayMs: 500,
  maxConcurrencyPerHost: 5,
  allowedHosts: WORKABLE_HOSTS,
};

/** A nullable, possibly-empty string the widget uses for most optional fields. */
const LooseString = z.string().nullish();

export const WorkableLocationSchema = z.object({
  country: LooseString,
  countryCode: LooseString,
  city: LooseString,
  region: LooseString,
  hidden: z.boolean().nullish(),
});

export const WorkableRawJobSchema = z.object({
  title: z.string().min(1),
  shortcode: z.string().min(1),
  code: LooseString,
  employment_type: LooseString,
  telecommuting: z.boolean().nullish(),
  department: LooseString,
  url: LooseString,
  shortlink: LooseString,
  application_url: LooseString,
  published_on: LooseString,
  created_at: LooseString,
  country: LooseString,
  city: LooseString,
  state: LooseString,
  education: LooseString,
  experience: LooseString,
  function: LooseString,
  industry: LooseString,
  locations: z.array(WorkableLocationSchema).nullish(),
  description: LooseString,
  /** Not seen live; kept so a future widget version with these keys is used, not dropped. */
  requirements: LooseString,
  benefits: LooseString,
  workplace_type: LooseString,
});
export type WorkableRawJob = z.infer<typeof WorkableRawJobSchema>;

export const WorkableAccountSchema = z.object({
  name: LooseString,
  description: LooseString,
  jobs: z.array(WorkableRawJobSchema),
});
export type WorkableAccount = z.infer<typeof WorkableAccountSchema>;

/** Known account hosts; a board_key must be a bare Workable subdomain. */
const BOARD_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function workableListUrl(boardKey: string): string {
  if (!BOARD_KEY.test(boardKey)) throw new Error(`workable: invalid board_key "${boardKey}"`);
  return `https://apply.workable.com/api/v1/widget/accounts/${boardKey}?details=true`;
}

/**
 * `YYYY-MM-DD` → midnight UTC; a full datetime is parsed as-is. Returns null for anything
 * unparseable so a surprising format degrades to FIRST_SEEN instead of throwing.
 */
export function parseWorkableDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00Z` : trimmed;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms);
}

/** Plan 3.2: published_on, then created_at, else null (caller stamps FIRST_SEEN). */
export function parseWorkablePostedAt(raw: Pick<WorkableRawJob, 'published_on' | 'created_at'>): Date | null {
  return parseWorkableDate(raw.published_on) ?? parseWorkableDate(raw.created_at);
}

function nonEmpty(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

/** "City, Region, Country" per location entry, falling back to the job's top-level fields. */
export function workableLocations(raw: WorkableRawJob): string[] {
  const out: string[] = [];
  for (const loc of raw.locations ?? []) {
    const label = [loc.city, loc.region, loc.country].map(nonEmpty).filter((p): p is string => p !== null).join(', ');
    if (label && !out.includes(label)) out.push(label);
  }
  if (out.length === 0) {
    const label = [raw.city, raw.state, raw.country].map(nonEmpty).filter((p): p is string => p !== null).join(', ');
    if (label) out.push(label);
  }
  return out;
}

function descriptionHtml(raw: WorkableRawJob): string {
  let html = raw.description ?? '';
  if (nonEmpty(raw.requirements)) html += `<h3>Requirements</h3>${raw.requirements}`;
  if (nonEmpty(raw.benefits)) html += `<h3>Benefits</h3>${raw.benefits}`;
  return html;
}

/** The widget payload carries no structured salary; keep the hook so a future key is mapped once. */
function salaryOf(_raw: WorkableRawJob): Salary | null {
  return null;
}

/** The list call; `log` receives one count line when jobs without any URL were dropped. */
export async function listWorkableJobs(board: Board, http: HttpClient, log?: (line: string) => void): Promise<WorkableRawJob[]> {
  const res = await http.getJson({
    url: workableListUrl(board.board_key),
    allowedHosts: WORKABLE_POLICY.allowedHosts,
    limits: limitsOf(WORKABLE_POLICY),
  });
  if (res.notModified) return [];
  const parsed = parseOrThrow(WorkableAccountSchema, res.data, `workable:${board.board_key}`);
  // A job with no URL at all cannot be applied to; drop it (counted, never named: logs are public).
  const usable = parsed.jobs.filter((j) => nonEmpty(j.application_url) ?? nonEmpty(j.url) ?? nonEmpty(j.shortlink));
  const dropped = parsed.jobs.length - usable.length;
  if (dropped > 0) log?.(`workable:${board.board_key}: dropped ${dropped} job(s) without an apply url`);
  return usable;
}

export const workableAdapter: SourceAdapter<WorkableRawJob> = {
  source: 'workable',
  policy: WORKABLE_POLICY,

  async listJobs(board: Board, http: HttpClient): Promise<WorkableRawJob[]> {
    return listWorkableJobs(board, http);
  },

  parsePostedAt(raw: WorkableRawJob): Date | null {
    return parseWorkablePostedAt(raw);
  },

  canonicalKey(raw: WorkableRawJob, board: Board): string {
    return canonicalKey('workable', board.board_key, raw.shortcode);
  },

  toInput(raw: WorkableRawJob, _board: Board, firstSeenAt: Date): JobPostingInput {
    const postedAt = parseWorkablePostedAt(raw);
    const hostedUrl = nonEmpty(raw.url) ?? nonEmpty(raw.shortlink);
    const applyUrl = nonEmpty(raw.application_url) ?? hostedUrl;
    const remoteKnown = typeof raw.telecommuting === 'boolean' || nonEmpty(raw.workplace_type) !== null;
    const remote = raw.telecommuting === true || raw.workplace_type?.trim().toLowerCase() === 'remote';
    return JobPostingInputSchema.parse({
      externalId: raw.shortcode,
      internalReqId: nonEmpty(raw.code),
      title: raw.title.trim(),
      descriptionHtml: descriptionHtml(raw),
      locations: workableLocations(raw),
      employmentType: nonEmpty(raw.employment_type),
      remoteFlag: remoteKnown ? remote : null,
      applyUrl,
      hostedUrl,
      postedAt: postedAt ? postedAt.toISOString() : firstSeenAt.toISOString(),
      postedAtSource: postedAt ? 'ATS_FIELD' : 'FIRST_SEEN',
      salary: salaryOf(raw),
      department: nonEmpty(raw.department),
      applicationDeadline: null,
    });
  },
};

/** True when the error means "this subdomain is not a Workable customer" (404, or a 302 off-host). */
export function isWorkableBoardNotFound(err: unknown): boolean {
  if (!(err instanceof HttpError)) return false;
  if (err.code === 'http_status' && err.status === 404) return true;
  // www.workable.com redirects every unknown account somewhere; a redirect we refused to follow
  // (off the Workable hosts) is the same signal.
  return err.code === 'redirect_not_allowed';
}
