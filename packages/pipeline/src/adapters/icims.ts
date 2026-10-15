/**
 * iCIMS adapter (plan sections 3.1 "iCIMS … HTML / internal JSON", 3.5 JSON-LD, 10.3).
 *
 * iCIMS has no public JSON job-board API. Every portal (`https://{label}.icims.com`, where the
 * label is `careers-gdms`, `careersus-shure`, `university-uber`, …) serves two zero-auth pages:
 *
 *   GET https://{label}.icims.com/jobs/search?pr={page}&mobile=true&needsRedirect=false
 *       The job list, 20–50 cards per page (`<li class="iCIMS_JobCardItem">` on current portals,
 *       `<tr class="iCIMS_JobListingRow">` on older ones). Each card carries the job URL with the
 *       numeric id, the title, the posted date (`<span title="10/9/2026 2:00 PM">`), and a
 *       label/value list (Job Location, Category, ID, salary range …). The `in_iframe=1` variant
 *       only pages correctly with the session cookie from the first response; the mobile variant
 *       pages without state, so it is the one we use.
 *   GET https://{label}.icims.com/jobs/{id}/job?in_iframe=1
 *       The job page, which embeds a schema.org `JobPosting` JSON-LD block: `description` (HTML),
 *       `datePosted` (ISO), `validThrough`, `employmentType`, `jobLocation[]`, `hiringOrganization`.
 *
 * Posture: one concurrent request per portal, 2 s apart, robots.txt honoured by the client (some
 * portals disallow everything, e.g. careers-sig; those boards fail with `robots_disallowed` and
 * the seed marks them disabled). The list page gives everything the diff engine needs; the job page
 * is fetched only for new keys (detail cap applies), so a 400-job portal costs ~10 list requests.
 * Posted dates on the list are portal-local wall-clock times with no zone; they are parsed as UTC
 * (date-level precision for our purposes) and replaced by the JSON-LD `datePosted` once fetched.
 */
import { z } from 'zod';
import type { Board } from '../schema/board.ts';
import { JobPostingInputSchema, type JobPostingInput } from '../schema/job.ts';
import { HttpError, type HttpClient } from '../http/client.ts';
import { canonicalKey } from '../ids.ts';
import { limitsOf, type AdapterPolicy, type SourceAdapter } from './types.ts';
import { parseOrThrow } from './parse.ts';

export const ICIMS_MAX_PAGES = 100;

export const ICIMS_POLICY: AdapterPolicy = {
  minDelayMs: 2_000,
  maxConcurrencyPerHost: 1,
  allowedHosts: ['*.icims.com'],
};

/** The pieces of a job as parsed from one list card. Unknown labels are kept in `fields`. */
export const IcimsRawJobSchema = z.object({
  id: z.string().regex(/^\d+$/),
  title: z.string().min(1),
  url: z.string().min(1),
  /** `M/D/YYYY h:mm AM` from the card's Posted Date tooltip, when present. */
  postedText: z.string().nullish(),
  location: z.string().nullish(),
  category: z.string().nullish(),
  reqId: z.string().nullish(),
  employmentType: z.string().nullish(),
  salaryText: z.string().nullish(),
  /** The teaser paragraph on the card; replaced by the JSON-LD description after fetchDetail. */
  snippetHtml: z.string().nullish(),
  detail: z
    .object({
      title: z.string().nullish(),
      descriptionHtml: z.string().nullish(),
      datePosted: z.string().nullish(),
      validThrough: z.string().nullish(),
      employmentType: z.string().nullish(),
      locations: z.array(z.string()).nullish(),
      organization: z.string().nullish(),
      url: z.string().nullish(),
    })
    .optional(),
});
export type IcimsRawJob = z.infer<typeof IcimsRawJobSchema>;

/** schema.org JobPosting as iCIMS emits it. Only the fields we read; the rest is stripped. */
const PostalAddressSchema = z.object({
  addressLocality: z.string().nullish(),
  addressRegion: z.string().nullish(),
  addressCountry: z.string().nullish(),
});
const JobLocationSchema = z.object({ address: PostalAddressSchema.nullish() });
export const IcimsJsonLdSchema = z.object({
  '@type': z.string().nullish(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  datePosted: z.string().nullish(),
  validThrough: z.string().nullish(),
  employmentType: z.union([z.string(), z.array(z.string())]).nullish(),
  hiringOrganization: z.object({ name: z.string().nullish() }).nullish(),
  jobLocation: z.union([JobLocationSchema, z.array(JobLocationSchema)]).nullish(),
  url: z.string().nullish(),
});

/** `careers-gdms` → `careers-gdms.icims.com`; a careers_url on an icims.com host wins when set. */
export function icimsHost(board: Board): string {
  const key = board.board_key.toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(key)) throw new Error(`icims:${board.board_key}: board_key must be the portal label`);
  try {
    const host = new URL(board.careers_url).hostname.toLowerCase();
    if (host.endsWith('.icims.com') && host.split('.').length === 3) return host;
  } catch {
    // fall through to the constructed host
  }
  return `${key}.icims.com`;
}

export function icimsListUrl(board: Board, page: number): string {
  return `https://${icimsHost(board)}/jobs/search?pr=${page}&mobile=true&needsRedirect=false`;
}

export function icimsJobUrl(board: Board, id: string): string {
  return `https://${icimsHost(board)}/jobs/${id}/job`;
}

export function icimsDetailUrl(board: Board, id: string): string {
  return `${icimsJobUrl(board, id)}?in_iframe=1`;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decode the HTML entities iCIMS uses in attributes and text (named, decimal, hex). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    const b = body.toLowerCase();
    if (b.startsWith('#x')) return String.fromCodePoint(Number.parseInt(b.slice(2), 16) || 0x20);
    if (b.startsWith('#')) return String.fromCodePoint(Number.parseInt(b.slice(1), 10) || 0x20);
    return ENTITIES[b] ?? m;
  });
}

function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Split a search page into card chunks; supports the card (`li`) and table-row layouts. */
function cards(html: string): string[] {
  const starts: number[] = [];
  const re = /<(?:li|tr)\b[^>]*class="[^"]*\b(?:iCIMS_JobCardItem|iCIMS_JobListingRow)\b[^"]*"/g;
  for (const m of html.matchAll(re)) starts.push(m.index ?? 0);
  return starts.map((s, i) => html.slice(s, starts[i + 1] ?? html.length));
}

const FIELD_RE = /<dt[^>]*class="[^"]*iCIMS_JobHeaderField[^"]*"[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*class="[^"]*iCIMS_JobHeaderData[^"]*"[^>]*>([\s\S]*?)<\/dd>/g;

/** Parse one list card into a raw job; null when it has no job link. */
export function parseIcimsCard(card: string, host: string): IcimsRawJob | null {
  const link = new RegExp(`href="(https?://${host.replace(/\./g, '\\.')}/jobs/(\\d+)/[^"]*)"`, 'i').exec(card);
  if (!link) return null;
  const id = link[2] ?? '';
  const anchorTitle = /<a\b[^>]*\btitle="([^"]*)"/i.exec(card)?.[1];
  const heading = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i.exec(card)?.[1];
  let title = heading ? textOf(heading) : anchorTitle ? decodeEntities(anchorTitle).replace(/^\d+\s*-\s*/, '').trim() : '';
  if (!title) return null;
  title = title.replace(/\s+/g, ' ');
  const posted = /Posted Date[\s\S]{0,200}?<span[^>]*\btitle="(\d{1,2}\/\d{1,2}\/\d{4}[^"]*)"/i.exec(card)?.[1] ?? /<span[^>]*\btitle="(\d{1,2}\/\d{1,2}\/\d{4}[^"]*)"/i.exec(card)?.[1] ?? null;
  const fields: Record<string, string> = {};
  for (const m of card.matchAll(FIELD_RE)) {
    const label = textOf(m[1] ?? '').toLowerCase();
    const value = textOf(m[2] ?? '');
    if (label && value) fields[label] = value;
  }
  const pick = (re: RegExp): string | null => {
    for (const [label, value] of Object.entries(fields)) if (re.test(label)) return value;
    return null;
  };
  const snippet = /<div[^>]*class="[^"]*\bdescription\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(card)?.[1] ?? null;
  const raw: IcimsRawJob = {
    id,
    title,
    url: decodeEntities(link[1] ?? '').split('?')[0] ?? '',
    postedText: posted ? decodeEntities(posted) : null,
    location: pick(/location/),
    category: pick(/categor|department|function/),
    reqId: pick(/^(id|req(uisition)?( id| number)?|job id)$/),
    employmentType: pick(/employment type|job type|position type|type of employment|schedule/),
    salaryText: pick(/salary|pay range|compensation/),
    snippetHtml: snippet ? snippet.trim() : null,
  };
  return IcimsRawJobSchema.parse(raw);
}

/** True when the HTML is an iCIMS search page (even an empty one); false for login/error pages. */
export function isIcimsSearchPage(html: string): boolean {
  return /iCIMS_JobsTable|iCIMS_JobCardItem|iCIMS_JobListingRow|iCIMS_MainWrapper|No Results Found/i.test(html);
}

/** `10/9/2026 2:00 PM` or `10/9/2026` → ISO (treated as UTC; no zone is given). */
export function parseIcimsDate(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*([AP]M))?/i.exec(text.trim());
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  let hour = m[4] ? Number(m[4]) % 12 : 0;
  const minute = m[5] ? Number(m[5]) : 0;
  if (m[6]?.toUpperCase() === 'PM') hour += 12;
  const at = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return Number.isNaN(at.getTime()) || month < 1 || month > 12 || day < 1 || day > 31 ? null : at.toISOString();
}

function parseIsoLoose(text: string | null | undefined): string | null {
  if (!text) return null;
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** `USD $124,397.00 - USD $138,003.00 /Yr.` → structured salary; null when unparseable. */
export function parseIcimsSalary(text: string | null | undefined): JobPostingInput['salary'] {
  if (!text) return null;
  const nums = [...text.matchAll(/\$\s?([\d,]+(?:\.\d+)?)/g)].map((m) => Number((m[1] ?? '').replace(/,/g, '')));
  if (nums.length === 0 || nums.some((n) => !Number.isFinite(n))) return null;
  const period = /\/\s*(yr|year|annum)/i.test(text) ? 'year' : /\/\s*(hr|hour)/i.test(text) ? 'hour' : /\/\s*(mo|month)/i.test(text) ? 'month' : null;
  const currency = /\b([A-Z]{3})\b/.exec(text)?.[1] ?? 'USD';
  return { min: nums[0] ?? null, max: nums[1] ?? nums[0] ?? null, currency, period };
}

/** Extract and validate the JobPosting JSON-LD from a job page; null when the page has none. */
export function parseIcimsJsonLd(html: string, label: string): z.infer<typeof IcimsJsonLdSchema> | null {
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try {
      data = JSON.parse(m[1] ?? '');
    } catch {
      continue;
    }
    const candidates = Array.isArray(data) ? data : [data];
    for (const c of candidates) {
      if (c && typeof c === 'object' && (c as { '@type'?: unknown })['@type'] === 'JobPosting') {
        return parseOrThrow(IcimsJsonLdSchema, c, `${label} json-ld`);
      }
    }
  }
  return null;
}

function jsonLdLocations(ld: z.infer<typeof IcimsJsonLdSchema>): string[] {
  const list = ld.jobLocation ? (Array.isArray(ld.jobLocation) ? ld.jobLocation : [ld.jobLocation]) : [];
  const out: string[] = [];
  for (const loc of list) {
    const a = loc.address;
    const parts = [a?.addressLocality, a?.addressRegion, a?.addressCountry].map((p) => p?.trim()).filter((p): p is string => !!p && p.toUpperCase() !== 'UNAVAILABLE');
    const s = parts.join(', ');
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

export function icimsLocations(raw: IcimsRawJob): string[] {
  const detail = raw.detail?.locations ?? [];
  if (detail.length > 0) return detail;
  const v = raw.location?.trim();
  return v ? [v] : [];
}

async function getHtml(http: HttpClient, url: string): Promise<string | null> {
  const res = await http.request({ url, headers: { accept: 'text/html' }, allowedHosts: ICIMS_POLICY.allowedHosts, limits: limitsOf(ICIMS_POLICY) });
  if (res.notModified) return null;
  return res.body;
}

export const icimsAdapter: SourceAdapter<IcimsRawJob> = {
  source: 'icims',
  policy: ICIMS_POLICY,

  async listJobs(board, http) {
    const host = icimsHost(board);
    const label = `icims:${board.board_key}`;
    const jobs: IcimsRawJob[] = [];
    const seen = new Set<string>();
    for (let page = 0; page < ICIMS_MAX_PAGES; page += 1) {
      const html = await getHtml(http, icimsListUrl(board, page));
      if (html === null) return jobs; // 304: nothing newer than what we have
      if (!isIcimsSearchPage(html)) {
        // A login wall, an error page or a challenge: fail the fetch so nothing closes.
        throw new HttpError('bad_json', host, 200);
      }
      let added = 0;
      for (const card of cards(html)) {
        const raw = parseIcimsCard(card, host);
        if (!raw || seen.has(raw.id)) continue;
        seen.add(raw.id);
        jobs.push(raw);
        added += 1;
      }
      if (added === 0) return jobs; // last page (or a repeated page): nothing new
    }
    throw new Error(`${label}: paging exceeded ${ICIMS_MAX_PAGES} pages`);
  },

  async fetchDetail(board, raw, http) {
    const label = `icims:${board.board_key}`;
    const html = await getHtml(http, icimsDetailUrl(board, raw.id));
    if (html === null) return raw;
    const ld = parseIcimsJsonLd(html, label);
    if (!ld) return raw; // page without structured data: keep the list fields
    const employment = Array.isArray(ld.employmentType) ? ld.employmentType.join(', ') : ld.employmentType;
    return {
      ...raw,
      detail: {
        title: ld.title ?? null,
        descriptionHtml: ld.description ?? null,
        datePosted: ld.datePosted ?? null,
        validThrough: ld.validThrough ?? null,
        employmentType: employment ?? null,
        locations: jsonLdLocations(ld),
        organization: ld.hiringOrganization?.name ?? null,
        url: ld.url ?? null,
      },
    };
  },

  parsePostedAt(raw) {
    const iso = parseIsoLoose(raw.detail?.datePosted) ?? parseIcimsDate(raw.postedText);
    return iso ? new Date(iso) : null;
  },

  canonicalKey(raw, board) {
    return canonicalKey('icims', board.board_key, raw.id);
  },

  toInput(raw, board, firstSeenAt): JobPostingInput {
    const postedIso = parseIsoLoose(raw.detail?.datePosted) ?? parseIcimsDate(raw.postedText);
    const employmentType = raw.detail?.employmentType ?? raw.employmentType ?? null;
    return JobPostingInputSchema.parse({
      externalId: raw.id,
      internalReqId: raw.reqId ?? null,
      title: raw.detail?.title?.trim() || raw.title,
      descriptionHtml: raw.detail?.descriptionHtml ?? raw.snippetHtml ?? '',
      locations: icimsLocations(raw),
      employmentType: employmentType && !/^other$/i.test(employmentType) ? employmentType : null,
      remoteFlag: /\bremote\b/i.test(`${raw.location ?? ''} ${raw.title}`) ? true : null,
      applyUrl: icimsJobUrl(board, raw.id),
      hostedUrl: icimsJobUrl(board, raw.id),
      postedAt: postedIso ?? firstSeenAt.toISOString(),
      postedAtSource: postedIso ? 'ATS_FIELD' : 'FIRST_SEEN',
      salary: parseIcimsSalary(raw.salaryText),
      department: raw.category ?? null,
      applicationDeadline: parseIsoLoose(raw.detail?.validThrough),
    });
  },
};
