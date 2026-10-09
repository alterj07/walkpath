import { z } from 'zod';
import type { Board } from '../schema/board.ts';
import type { JobPostingInput, Salary } from '../schema/index.ts';
import { JobPostingInputSchema } from '../schema/index.ts';
import type { HttpClient } from '../http/client.ts';
import { canonicalKey } from '../ids.ts';
import { limitsOf, type AdapterPolicy, type SourceAdapter } from './types.ts';
import { parseOrThrow } from './parse.ts';

/**
 * Ashby public Job Posting API (plan sections 3.1, 3.2, 10.2).
 *
 * The ONLY endpoint this adapter calls is
 *   https://api.ashbyhq.com/posting-api/job-board/{name}?includeCompensation=true
 * which Ashby documents as public and unauthenticated. It never touches
 * jobs.ashbyhq.com/api/* (the undocumented GraphQL behind the hosted board): that
 * path is disallowed by jobs.ashbyhq.com/robots.txt.
 */

const API_HOST = 'api.ashbyhq.com';

export const ASHBY_POLICY: AdapterPolicy = {
  minDelayMs: 0,
  maxConcurrencyPerHost: 10,
  allowedHosts: [API_HOST, 'jobs.ashbyhq.com'],
};

// ---- raw payload schemas (unknown keys stripped, nulls accepted) ----

const PostalAddressSchema = z.object({
  addressLocality: z.string().nullish(),
  addressRegion: z.string().nullish(),
  addressCountry: z.string().nullish(),
});

const AddressSchema = z.object({ postalAddress: PostalAddressSchema.nullish() });

const SecondaryLocationSchema = z.object({
  location: z.string().nullish(),
  address: AddressSchema.nullish(),
});

export const AshbyCompensationComponentSchema = z.object({
  id: z.string().nullish(),
  summary: z.string().nullish(),
  compensationType: z.string().nullish(),
  interval: z.string().nullish(),
  currencyCode: z.string().nullish(),
  minValue: z.number().nullish(),
  maxValue: z.number().nullish(),
});

const CompensationTierSchema = z.object({
  id: z.string().nullish(),
  title: z.string().nullish(),
  tierSummary: z.string().nullish(),
  additionalInformation: z.string().nullish(),
  components: z.array(AshbyCompensationComponentSchema).nullish(),
});

export const AshbyCompensationSchema = z.object({
  compensationTierSummary: z.string().nullish(),
  scrapeableCompensationSalarySummary: z.string().nullish(),
  compensationTiers: z.array(CompensationTierSchema).nullish(),
  summaryComponents: z.array(AshbyCompensationComponentSchema).nullish(),
});

/** One job as returned by the posting API. Fields observed live on 4 boards, 2026-10-09. */
export const AshbyRawJobSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  department: z.string().nullish(),
  team: z.string().nullish(),
  /** 'FullTime' | 'PartTime' | 'Intern' | 'Contract' | 'Temporary' (kept open for new values). */
  employmentType: z.string().nullish(),
  location: z.string().nullish(),
  shouldDisplayCompensationOnJobPostings: z.boolean().nullish(),
  secondaryLocations: z.array(SecondaryLocationSchema).nullish(),
  publishedAt: z.string().nullish(),
  isListed: z.boolean().nullish(),
  isRemote: z.boolean().nullish(),
  /** 'Remote' | 'Hybrid' | 'OnSite'; null on some boards (Notion). */
  workplaceType: z.string().nullish(),
  address: AddressSchema.nullish(),
  jobUrl: z.string().min(1),
  applyUrl: z.string().min(1),
  descriptionHtml: z.string().nullish(),
  descriptionPlain: z.string().nullish(),
  compensation: AshbyCompensationSchema.nullish(),
});
export type AshbyRawJob = z.infer<typeof AshbyRawJobSchema>;

export const AshbyBoardResponseSchema = z.object({
  apiVersion: z.union([z.number(), z.string()]).nullish(),
  jobs: z.array(AshbyRawJobSchema),
});

// ---- helpers ----

export function ashbyBoardUrl(boardKey: string): string {
  return `https://${API_HOST}/posting-api/job-board/${encodeURIComponent(boardKey)}?includeCompensation=true`;
}

const INTERVAL_TO_PERIOD: Record<string, Salary['period']> = {
  '1 HOUR': 'hour',
  '1 DAY': 'day',
  '1 WEEK': 'week',
  '1 MONTH': 'month',
  '1 YEAR': 'year',
};

/**
 * First Salary/Hourly component with a numeric bound, from the compensation tiers (then the
 * summary components as a fallback). Equity, bonus and commission components are ignored.
 */
export function ashbySalary(raw: AshbyRawJob): Salary | null {
  const comp = raw.compensation;
  if (!comp) return null;
  const candidates = [
    ...(comp.compensationTiers ?? []).flatMap((t) => t.components ?? []),
    ...(comp.summaryComponents ?? []),
  ];
  for (const c of candidates) {
    if (c.compensationType !== 'Salary' && c.compensationType !== 'Hourly') continue;
    if (c.minValue == null && c.maxValue == null) continue;
    const period = c.interval ? (INTERVAL_TO_PERIOD[c.interval] ?? null) : c.compensationType === 'Hourly' ? 'hour' : null;
    const currency = c.currencyCode && /^[A-Za-z]{3}$/.test(c.currencyCode) ? c.currencyCode.toUpperCase() : 'USD';
    return { min: c.minValue ?? null, max: c.maxValue ?? null, currency, period };
  }
  return null;
}

function parseIso(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Live data shows `isRemote: true` on jobs whose workplaceType is Hybrid or OnSite (Ramp,
 * Skydio), so workplaceType is treated as authoritative and isRemote is only a fallback
 * when workplaceType is absent.
 */
export function ashbyRemoteFlag(raw: AshbyRawJob): boolean | null {
  if (raw.workplaceType) return raw.workplaceType === 'Remote';
  return raw.isRemote ?? null;
}

// ---- adapter ----

export const ashbyAdapter: SourceAdapter<AshbyRawJob> = {
  source: 'ashby',
  policy: ASHBY_POLICY,

  async listJobs(board: Board, http: HttpClient): Promise<AshbyRawJob[]> {
    const res = await http.getJson({
      url: ashbyBoardUrl(board.board_key),
      allowedHosts: ASHBY_POLICY.allowedHosts,
      limits: limitsOf(ASHBY_POLICY),
    });
    if (res.notModified || res.data === null) return [];
    const parsed = parseOrThrow(AshbyBoardResponseSchema, res.data, `ashby:${board.board_key}`);
    return parsed.jobs.filter((j) => j.isListed !== false);
  },

  parsePostedAt(raw: AshbyRawJob): Date | null {
    return parseIso(raw.publishedAt);
  },

  canonicalKey(raw: AshbyRawJob, board: Board): string {
    return canonicalKey('ashby', board.board_key, raw.id);
  },

  toInput(raw: AshbyRawJob, _board: Board, firstSeenAt: Date): JobPostingInput {
    const postedAt = parseIso(raw.publishedAt);
    const locations = [raw.location, ...(raw.secondaryLocations ?? []).map((l) => l.location)]
      .map((l) => (l ?? '').trim())
      .filter((l) => l.length > 0);
    return JobPostingInputSchema.parse({
      externalId: raw.id,
      internalReqId: null,
      title: raw.title,
      descriptionHtml: raw.descriptionHtml ?? '',
      locations,
      employmentType: raw.employmentType ?? null,
      remoteFlag: ashbyRemoteFlag(raw),
      applyUrl: raw.applyUrl,
      hostedUrl: raw.jobUrl,
      postedAt: (postedAt ?? firstSeenAt).toISOString(),
      postedAtSource: postedAt ? 'ATS_FIELD' : 'FIRST_SEEN',
      salary: ashbySalary(raw),
      department: raw.department ?? raw.team ?? null,
      applicationDeadline: null,
    });
  },
};
