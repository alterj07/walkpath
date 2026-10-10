import { z } from 'zod';
import { limitsOf, type AdapterPolicy, type SourceAdapter } from './types.ts';
import { parseOrThrow } from './parse.ts';
import type { Board } from '../schema/board.ts';
import { JobPostingInputSchema, type JobPostingInput } from '../schema/index.ts';
import type { HttpClient } from '../http/client.ts';
import { canonicalKey } from '../ids.ts';

/**
 * SimplifyJobs community lists (docs/sources.md): the curated GitHub repositories
 * `SimplifyJobs/Summer2027-Internships` and `SimplifyJobs/New-Grad-Positions`, whose
 * `listings.json` carries company, title, locations, apply URL, posting time, sponsorship
 * and degree hints for every row of the README tables. The lists hold facts about public
 * postings (no descriptions), so each job gets a short generated description that names
 * the list it came from; the publish step drops a listing when the same apply URL is
 * already published from the employer's own ATS (merge.ts, `deduped_listing`).
 *
 * One request per list per run. Both lists are large (~13 MB each); the HttpClient body
 * cap is raised for this adapter only.
 */

export const SIMPLIFY_HOST = 'raw.githubusercontent.com';

/** Registry board_key → GitHub repository and the employment type every row carries. */
export const SIMPLIFY_BOARDS: Readonly<Record<string, { repo: string; employmentType: string }>> = {
  'summer-internships': { repo: 'SimplifyJobs/Summer2027-Internships', employmentType: 'Internship' },
  'new-grad-positions': { repo: 'SimplifyJobs/New-Grad-Positions', employmentType: 'New Grad' },
};

export const SIMPLIFY_POLICY: AdapterPolicy = {
  minDelayMs: 0,
  maxConcurrencyPerHost: 2,
  // Apply URLs point at the employer's own board or site; `simplify.jobs` appears as a
  // redirect host on some rows and is accepted with attribution (plan 10.4).
  allowedHosts: [SIMPLIFY_HOST, 'simplify.jobs', 'www.simplify.jobs'],
};

/** Both lists exceed the client's default 5 MB body cap. */
export const SIMPLIFY_MAX_BODY_BYTES = 40 * 1024 * 1024;

/* ---------- Raw payload schema (zod at the boundary; unknown keys are stripped) ---------- */

export const SimplifyListingSchema = z.object({
  id: z.string().min(1),
  company_name: z.string().nullish(),
  title: z.string().min(1),
  active: z.boolean().nullish(),
  is_visible: z.boolean().nullish(),
  url: z.string().min(1),
  company_url: z.string().nullish(),
  locations: z.array(z.string()).nullish(),
  /** Epoch seconds. */
  date_posted: z.number().nullish(),
  date_updated: z.number().nullish(),
  /** Internship list only: e.g. ["Summer 2027"]. */
  terms: z.array(z.string()).nullish(),
  season: z.string().nullish(),
  sponsorship: z.string().nullish(),
  degrees: z.array(z.string()).nullish(),
  category: z.string().nullish(),
  source: z.string().nullish(),
});
export type SimplifyListing = z.infer<typeof SimplifyListingSchema>;

/** The list JSON is a bare array of listings. */
export const SimplifyListSchema = z.array(SimplifyListingSchema);

/** A listing plus the board it came from, so `toInput` knows the employment type. */
export interface SimplifyRawJob extends SimplifyListing {
  boardKey: string;
}

export function simplifyListUrl(boardKey: string): string {
  const board = SIMPLIFY_BOARDS[boardKey];
  if (!board) throw new Error(`simplify: unknown board_key "${boardKey}" (expected ${Object.keys(SIMPLIFY_BOARDS).join(', ')})`);
  return `https://${SIMPLIFY_HOST}/${board.repo}/dev/.github/scripts/listings.json`;
}

/** SimplifyJobs appends its own attribution parameters to employer links; strip only those. */
const TRACKING_PARAMS = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'ref', 'source', 'utm_content']);

export function stripSimplifyTracking(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return raw.trim();
  }
  for (const key of [...url.searchParams.keys()]) {
    const value = url.searchParams.get(key) ?? '';
    if (TRACKING_PARAMS.has(key.toLowerCase()) && /simplify/i.test(value)) url.searchParams.delete(key);
  }
  return url.toString();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The lists carry no job description; say where the row came from and what it tells us. */
export function simplifyDescriptionHtml(raw: SimplifyRawJob): string {
  const board = SIMPLIFY_BOARDS[raw.boardKey];
  const parts: string[] = [];
  parts.push(`<p>Listed on the SimplifyJobs ${raw.boardKey === 'new-grad-positions' ? 'New Grad Positions' : 'Summer Internships'} list${board ? ` (${escapeHtml(board.repo)})` : ''}. The employer's posting has the full description; this entry carries only what the list records.</p>`);
  const facts: string[] = [];
  if (raw.category) facts.push(`Category: ${escapeHtml(raw.category)}`);
  const terms = (raw.terms ?? []).filter((t) => t && t !== 'N/A');
  if (terms.length > 0) facts.push(`Term: ${escapeHtml(terms.join(', '))}`);
  if (raw.season) facts.push(`Season: ${escapeHtml(raw.season)}`);
  const degrees = (raw.degrees ?? []).filter(Boolean);
  if (degrees.length > 0) facts.push(`Degrees listed: ${escapeHtml(degrees.join(', '))}`);
  if (raw.sponsorship && raw.sponsorship !== 'Other') facts.push(`Work authorization note: ${escapeHtml(raw.sponsorship)}`);
  if (facts.length > 0) parts.push(`<ul>${facts.map((f) => `<li>${f}</li>`).join('')}</ul>`);
  return parts.join('\n');
}

export function parseSimplifyPostedAt(raw: SimplifyRawJob): Date | null {
  const seconds = raw.date_posted ?? raw.date_updated;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  const d = new Date(seconds * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function listJobs(board: Board, http: HttpClient): Promise<SimplifyRawJob[]> {
  const res = await http.getJson({
    url: simplifyListUrl(board.board_key),
    allowedHosts: SIMPLIFY_POLICY.allowedHosts,
    limits: limitsOf(SIMPLIFY_POLICY),
    maxBodyBytes: SIMPLIFY_MAX_BODY_BYTES,
  });
  if (res.data === null) return [];
  const rows = parseOrThrow(SimplifyListSchema, res.data, `simplify:${board.board_key} list`);
  const seen = new Set<string>();
  const out: SimplifyRawJob[] = [];
  for (const row of rows) {
    if (row.active !== true || row.is_visible === false) continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push({ ...row, boardKey: board.board_key });
  }
  return out;
}

function toInput(raw: SimplifyRawJob, board: Board, firstSeenAt: Date): JobPostingInput {
  const posted = parseSimplifyPostedAt(raw);
  const applyUrl = stripSimplifyTracking(raw.url);
  const locations = (raw.locations ?? []).map((l) => l.trim()).filter((l) => l.length > 0);
  const employmentType = SIMPLIFY_BOARDS[raw.boardKey]?.employmentType ?? SIMPLIFY_BOARDS[board.board_key]?.employmentType ?? null;
  const companyName = raw.company_name?.trim() || null;
  return JobPostingInputSchema.parse({
    externalId: raw.id,
    internalReqId: null,
    title: raw.title,
    descriptionHtml: simplifyDescriptionHtml(raw),
    locations,
    employmentType,
    remoteFlag: locations.some((l) => /\bremote\b/i.test(l)) ? true : null,
    applyUrl,
    hostedUrl: applyUrl,
    postedAt: posted ? posted.toISOString() : firstSeenAt.toISOString(),
    postedAtSource: posted ? 'ATS_FIELD' : 'FIRST_SEEN',
    salary: null,
    department: raw.category ?? null,
    applicationDeadline: null,
    ...(companyName ? { companyName } : {}),
    ...(raw.company_url ? { companyUrl: raw.company_url } : {}),
  });
}

export const simplifyAdapter: SourceAdapter<SimplifyRawJob> = {
  source: 'simplify',
  policy: SIMPLIFY_POLICY,
  listJobs,
  parsePostedAt: (raw) => parseSimplifyPostedAt(raw),
  canonicalKey: (raw, board) => canonicalKey('simplify', board.board_key, raw.id),
  toInput,
};
