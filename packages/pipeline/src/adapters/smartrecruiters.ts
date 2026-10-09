/**
 * SmartRecruiters adapter (plan sections 3.1, 3.2, 4.3, 10.2).
 *
 * Why this adapter ignores robots.txt and wants an API key:
 * `api.smartrecruiters.com/robots.txt` is `User-agent: * / Disallow: /`. The Posting API
 * is nevertheless documented as public (no auth for public postings), and plan section
 * 10.2 settles the posture: we call it as a registered API client with a free developer
 * key (`X-SmartToken`), not as a crawler. So every request here sets `respectRobots: false`,
 * which is the ONE exception the HttpClient allows, and `listJobs` refuses to run without
 * `SMARTRECRUITERS_API_KEY` so the crawl job records the source as skipped rather than
 * polling anonymously.
 *
 * Endpoints:
 *   GET /v1/companies/{id}/postings?limit=100&offset=N   light list, paged by offset
 *   GET /v1/companies/{id}/postings/{postingId}           jobAd sections + apply/posting URLs
 */
import { z } from 'zod';
import type { Board } from '../schema/board.ts';
import { JobPostingInputSchema, type JobPostingInput } from '../schema/job.ts';
import type { HttpClient } from '../http/client.ts';
import { canonicalKey } from '../ids.ts';
import { limitsOf, type AdapterPolicy, type SourceAdapter } from './types.ts';
import { parseOrThrow } from './parse.ts';

export const SMARTRECRUITERS_API_HOST = 'api.smartrecruiters.com';
export const SMARTRECRUITERS_PAGE_SIZE = 100;
export const SMARTRECRUITERS_MISSING_KEY_MESSAGE =
  'smartrecruiters: SMARTRECRUITERS_API_KEY not set; this source is skipped';

export const SMARTRECRUITERS_POLICY: AdapterPolicy = {
  minDelayMs: 150,
  maxConcurrencyPerHost: 8,
  allowedHosts: ['api.smartrecruiters.com', 'jobs.smartrecruiters.com', 'careers.smartrecruiters.com'],
};

const LabelSchema = z.object({ id: z.string().nullish(), label: z.string().nullish() });

const LocationSchema = z.object({
  city: z.string().nullish(),
  region: z.string().nullish(),
  country: z.string().nullish(),
  remote: z.boolean().nullish(),
  hybrid: z.boolean().nullish(),
  fullLocation: z.string().nullish(),
});

const SectionSchema = z.object({ title: z.string().nullish(), text: z.string().nullish() });

/** Fields returned by the detail endpoint on top of the list fields. */
export const SmartRecruitersDetailSchema = z.object({
  id: z.string(),
  applyUrl: z.string().nullish(),
  postingUrl: z.string().nullish(),
  active: z.boolean().nullish(),
  jobAd: z
    .object({
      sections: z
        .object({
          companyDescription: SectionSchema.nullish(),
          jobDescription: SectionSchema.nullish(),
          qualifications: SectionSchema.nullish(),
          additionalInformation: SectionSchema.nullish(),
        })
        .nullish(),
    })
    .nullish(),
});
export type SmartRecruitersDetail = z.infer<typeof SmartRecruitersDetailSchema>;

/** One posting as the list endpoint returns it. Unknown keys are stripped; nulls tolerated. */
export const SmartRecruitersPostingSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  uuid: z.string().nullish(),
  refNumber: z.string().nullish(),
  company: z.object({ identifier: z.string().nullish(), name: z.string().nullish() }).nullish(),
  releasedDate: z.string().nullish(),
  location: LocationSchema.nullish(),
  department: LabelSchema.nullish(),
  function: LabelSchema.nullish(),
  industry: LabelSchema.nullish(),
  typeOfEmployment: LabelSchema.nullish(),
  experienceLevel: LabelSchema.nullish(),
  ref: z.string().nullish(),
  /** Set after fetchDetail. */
  detail: SmartRecruitersDetailSchema.optional(),
});
export type SmartRecruitersRawJob = z.infer<typeof SmartRecruitersPostingSchema>;

export const SmartRecruitersListSchema = z.object({
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  totalFound: z.number().int().nonnegative(),
  content: z.array(SmartRecruitersPostingSchema),
});

const SECTION_ORDER = ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation'] as const;

export interface SmartRecruitersAdapterOptions {
  /** The X-SmartToken value, or a thunk read at call time (so tests never touch the environment). */
  apiKey?: string | (() => string | undefined) | undefined;
}

function hostedUrlFor(board: Board, raw: SmartRecruitersRawJob): string {
  return `https://jobs.smartrecruiters.com/${encodeURIComponent(board.board_key)}/${encodeURIComponent(raw.id)}`;
}

/** The sections concatenated in the documented order; an empty section is skipped. */
export function descriptionFromDetail(detail: SmartRecruitersDetail | undefined): string {
  const sections = detail?.jobAd?.sections;
  if (!sections) return '';
  const parts: string[] = [];
  for (const key of SECTION_ORDER) {
    const section = sections[key];
    const text = section?.text?.trim() ?? '';
    if (!text) continue;
    const title = section?.title?.trim() ?? '';
    parts.push(title ? `<h3>${title}</h3>${text}` : text);
  }
  return parts.join('\n');
}

export function parseSmartRecruitersReleasedDate(raw: SmartRecruitersRawJob): Date | null {
  if (!raw.releasedDate) return null;
  const at = new Date(raw.releasedDate);
  return Number.isNaN(at.getTime()) ? null : at;
}

export function createSmartRecruitersAdapter(
  opts: SmartRecruitersAdapterOptions = {},
): SourceAdapter<SmartRecruitersRawJob> {
  const resolveKey = (): string | undefined => {
    const key = typeof opts.apiKey === 'function' ? opts.apiKey() : opts.apiKey;
    const trimmed = key?.trim();
    return trimmed ? trimmed : undefined;
  };

  const requestJson = async (http: HttpClient, url: string, apiKey: string): Promise<unknown> => {
    const res = await http.getJson({
      url,
      allowedHosts: SMARTRECRUITERS_POLICY.allowedHosts,
      limits: limitsOf(SMARTRECRUITERS_POLICY),
      headers: { 'x-smarttoken': apiKey },
      // The one documented exception; see the file comment.
      respectRobots: false,
    });
    return res.data;
  };

  return {
    source: 'smartrecruiters',
    policy: SMARTRECRUITERS_POLICY,

    async listJobs(board, http) {
      const apiKey = resolveKey();
      if (!apiKey) throw new Error(SMARTRECRUITERS_MISSING_KEY_MESSAGE);
      const company = encodeURIComponent(board.board_key);
      const jobs: SmartRecruitersRawJob[] = [];
      // Offset paging can repeat a posting when one is added mid-crawl; dedupe across pages.
      const seen = new Set<string>();
      let offset = 0;
      // Paged by offset; stop when the page is short or we reached totalFound.
      while (true) {
        const url = `https://${SMARTRECRUITERS_API_HOST}/v1/companies/${company}/postings?limit=${SMARTRECRUITERS_PAGE_SIZE}&offset=${offset}`;
        const data = await requestJson(http, url, apiKey);
        if (data === null) break; // 304: the caller decides what to do with an unchanged board
        const page = parseOrThrow(SmartRecruitersListSchema, data, `smartrecruiters:${board.board_key} offset ${offset}`);
        for (const posting of page.content) {
          if (seen.has(posting.id)) continue;
          seen.add(posting.id);
          jobs.push(posting);
        }
        offset += page.content.length;
        if (page.content.length === 0 || page.content.length < SMARTRECRUITERS_PAGE_SIZE || offset >= page.totalFound) break;
      }
      return jobs;
    },

    async fetchDetail(board, raw, http) {
      const apiKey = resolveKey();
      if (!apiKey) throw new Error(SMARTRECRUITERS_MISSING_KEY_MESSAGE);
      const url = `https://${SMARTRECRUITERS_API_HOST}/v1/companies/${encodeURIComponent(board.board_key)}/postings/${encodeURIComponent(raw.id)}`;
      const data = await requestJson(http, url, apiKey);
      if (data === null) return raw;
      return { ...raw, detail: parseOrThrow(SmartRecruitersDetailSchema, data, `smartrecruiters:${board.board_key} posting`) };
    },

    parsePostedAt(raw) {
      return parseSmartRecruitersReleasedDate(raw);
    },

    canonicalKey(raw, board) {
      return canonicalKey('smartrecruiters', board.board_key, raw.id);
    },

    toInput(raw, board, firstSeenAt): JobPostingInput {
      const postedAt = parseSmartRecruitersReleasedDate(raw);
      const loc = raw.location;
      const joined = [loc?.city, loc?.region, loc?.country].filter((p): p is string => Boolean(p && p.trim())).join(', ');
      const location = loc?.fullLocation?.trim() || joined;
      const hosted = raw.detail?.postingUrl?.trim() || hostedUrlFor(board, raw);
      return JobPostingInputSchema.parse({
        externalId: raw.id,
        internalReqId: raw.refNumber ?? null,
        title: raw.name,
        descriptionHtml: descriptionFromDetail(raw.detail),
        locations: location ? [location] : [],
        employmentType: raw.typeOfEmployment?.label ?? null,
        remoteFlag: loc?.remote ?? null,
        applyUrl: raw.detail?.applyUrl?.trim() || hosted,
        hostedUrl: hosted,
        postedAt: postedAt ? postedAt.toISOString() : firstSeenAt.toISOString(),
        postedAtSource: postedAt ? 'ATS_FIELD' : 'FIRST_SEEN',
        salary: null,
        department: raw.department?.label ?? null,
        applicationDeadline: null,
      });
    },
  };
}

/** Default instance: reads SMARTRECRUITERS_API_KEY from the environment at call time. */
export const smartrecruitersAdapter: SourceAdapter<SmartRecruitersRawJob> = createSmartRecruitersAdapter({
  apiKey: () => process.env['SMARTRECRUITERS_API_KEY'],
});
