/**
 * Full job records and the companies file (plan sections 2.2, 2.6, 6.3).
 * Records live in /data/jobs/<xx>.json buckets keyed by the first two hex
 * characters of the id. Every value is untrusted at this boundary: the guard
 * checks every field's type and shape and drops anything else.
 */
import {
  ARRANGEMENTS,
  FAMILIES,
  relativeTime,
  type Arrangement,
  type Family,
} from './data.ts';

export const POSTED_SOURCES = ['ATS_FIELD', 'WORKDAY_TEXT', 'FIRST_SEEN'] as const;
export type PostedSource = (typeof POSTED_SOURCES)[number];
export const EMPLOYMENT_TYPES = ['internship', 'co_op'] as const;
export const SPONSORSHIP = ['yes', 'no', 'unknown'] as const;
export const SALARY_PERIODS = ['hour', 'day', 'week', 'month', 'year'] as const;

export interface Salary {
  min: number | null;
  max: number | null;
  currency: string;
  period: (typeof SALARY_PERIODS)[number] | null;
}

export interface JobSummary {
  text: string;
  responsibilities: string[];
  qualifications: string[];
  must_have_skills: string[];
  nice_to_have_skills: string[];
  model: string;
  generated_at: string;
}

export interface JobRecord {
  id: string;
  title: string;
  title_raw: string;
  company: { slug: string; name: string; domain: string };
  location: {
    raw: string;
    city: string | null;
    state: string | null;
    country: string | null;
    arrangement: Arrangement;
    others: string[];
  };
  source: { ats: string; board: string; external_id: string };
  apply_url: string;
  apply_url_downgraded: boolean;
  posted_at: string;
  posted_at_source: PostedSource;
  first_seen_at: string;
  last_seen_at: string;
  closed_at: string | null;
  employment_type: (typeof EMPLOYMENT_TYPES)[number];
  role_family: Family;
  season: string | null;
  salary: Salary | null;
  citizenship_required: boolean | null;
  sponsorship: (typeof SPONSORSHIP)[number];
  grad_years: number[];
  summary: JobSummary | null;
  description_html: string;
  content_hash: string;
}

export interface CompanyEntry {
  name: string;
  domain: string;
  blurb: string | null;
  ats: string[];
  careers_url: string | null;
  open_count: number;
}
export type Companies = Record<string, CompanyEntry>;

export const ID_RE = /^[a-f0-9]{12}$/;
export const SLUG_RE = /^[a-z0-9-]{1,80}$/;
/** Sanitized descriptions are capped at 20 KB by the publish job; allow slack. */
const DESCRIPTION_MAX = 64 * 1024;
/** Bare hostname or empty (the registry may not know a domain). Validated once here; consumers trust it. */
const DOMAIN_RE = /^[a-z0-9.-]{0,253}$/i;
const STR_MAX = 500;
const LIST_MAX = 50;

function isStr(v: unknown, max = STR_MAX): v is string {
  return typeof v === 'string' && v.length <= max;
}
function isStrOrNull(v: unknown, max = STR_MAX): v is string | null {
  return v === null || isStr(v, max);
}
function isIso(v: unknown): v is string {
  return isStr(v, 40) && !Number.isNaN(Date.parse(v));
}
function isIsoOrNull(v: unknown): v is string | null {
  return v === null || isIso(v);
}
function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (list as readonly string[]).includes(v);
}
function strList(v: unknown, max = LIST_MAX, each = STR_MAX): string[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  const out: string[] = [];
  for (const s of v) {
    if (!isStr(s, each)) return null;
    out.push(s);
  }
  return out;
}
function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function numOrNull(v: unknown): v is number | null {
  return v === null || (typeof v === 'number' && Number.isFinite(v));
}

function parseSalary(v: unknown): Salary | null | undefined {
  if (v === null) return null;
  const s = obj(v);
  if (!s) return undefined;
  if (!numOrNull(s.min) || !numOrNull(s.max) || !isStr(s.currency, 3)) return undefined;
  if (!(s.period === null || isOneOf(SALARY_PERIODS, s.period))) return undefined;
  return { min: s.min, max: s.max, currency: s.currency, period: s.period };
}

function parseSummary(v: unknown): JobSummary | null | undefined {
  if (v === null) return null;
  const s = obj(v);
  if (!s) return undefined;
  const responsibilities = strList(s.responsibilities, 5);
  const qualifications = strList(s.qualifications, 6);
  const must = strList(s.must_have_skills, 20, 80);
  const nice = strList(s.nice_to_have_skills, 20, 80);
  if (!isStr(s.text, 1000) || !responsibilities || !qualifications || !must || !nice) return undefined;
  if (!isStr(s.model, 120) || !isIso(s.generated_at)) return undefined;
  return {
    text: s.text,
    responsibilities,
    qualifications,
    must_have_skills: must,
    nice_to_have_skills: nice,
    model: s.model,
    generated_at: s.generated_at,
  };
}

/**
 * Validates one untrusted value into a JobRecord, copying only known fields.
 * Returns null when any field is missing or has the wrong shape.
 */
export function parseJobRecord(v: unknown): JobRecord | null {
  const r = obj(v);
  if (!r) return null;
  const company = obj(r.company);
  const location = obj(r.location);
  const source = obj(r.source);
  if (!company || !location || !source) return null;
  if (!isStr(r.id, 12) || !ID_RE.test(r.id)) return null;
  if (!isStr(r.title) || r.title.length === 0 || !isStr(r.title_raw)) return null;
  if (!isStr(company.slug, 120) || !SLUG_RE.test(company.slug) || !isStr(company.name) || !isStr(company.domain, 253) || !DOMAIN_RE.test(company.domain)) return null;
  const others = strList(location.others, 100, 200);
  if (
    !isStr(location.raw, 300) || !isStrOrNull(location.city, 120) || !isStrOrNull(location.state, 40) ||
    !isStrOrNull(location.country, 40) || !isOneOf(ARRANGEMENTS, location.arrangement) || !others
  ) return null;
  if (!isStr(source.ats, 40) || !isStr(source.board, 200) || !isStr(source.external_id, 200)) return null;
  if (!isStr(r.apply_url, 2048) || typeof r.apply_url_downgraded !== 'boolean') return null;
  if (!isIso(r.posted_at) || !isOneOf(POSTED_SOURCES, r.posted_at_source)) return null;
  if (!isIso(r.first_seen_at) || !isIso(r.last_seen_at) || !isIsoOrNull(r.closed_at)) return null;
  if (!isOneOf(EMPLOYMENT_TYPES, r.employment_type) || !isOneOf(FAMILIES, r.role_family)) return null;
  if (!isStrOrNull(r.season, 40)) return null;
  const salary = parseSalary(r.salary);
  if (salary === undefined) return null;
  if (!(r.citizenship_required === null || typeof r.citizenship_required === 'boolean')) return null;
  if (!isOneOf(SPONSORSHIP, r.sponsorship)) return null;
  if (!Array.isArray(r.grad_years) || r.grad_years.length > 10 || !r.grad_years.every((y) => Number.isInteger(y) && y >= 2000 && y <= 2100)) return null;
  const summary = parseSummary(r.summary);
  if (summary === undefined) return null;
  if (!isStr(r.description_html, DESCRIPTION_MAX) || !isStr(r.content_hash, 64)) return null;

  return {
    id: r.id,
    title: r.title,
    title_raw: r.title_raw,
    company: { slug: company.slug, name: company.name, domain: company.domain },
    location: {
      raw: location.raw,
      city: location.city,
      state: location.state,
      country: location.country,
      arrangement: location.arrangement,
      others,
    },
    source: { ats: source.ats, board: source.board, external_id: source.external_id },
    apply_url: r.apply_url,
    apply_url_downgraded: r.apply_url_downgraded,
    posted_at: r.posted_at,
    posted_at_source: r.posted_at_source,
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
    closed_at: r.closed_at,
    employment_type: r.employment_type,
    role_family: r.role_family,
    season: r.season,
    salary,
    citizenship_required: r.citizenship_required,
    sponsorship: r.sponsorship,
    grad_years: r.grad_years as number[],
    summary,
    description_html: r.description_html,
    content_hash: r.content_hash,
  };
}

export function isJobRecord(v: unknown): v is JobRecord {
  return parseJobRecord(v) !== null;
}

/** Bucket file name for an id: the first two hex characters. */
export function bucketOf(id: string): string {
  return id.slice(0, 2);
}

/** Fetches one record from its bucket; null when the id is invalid, missing or malformed. */
export async function loadJob(id: string, fetchFn: typeof fetch = fetch): Promise<JobRecord | null> {
  if (!ID_RE.test(id)) return null;
  const res = await fetchFn(`/data/jobs/${bucketOf(id)}.json`);
  if (!res.ok) return null;
  const bucket = obj(await res.json());
  if (!bucket) return null;
  const record = parseJobRecord(bucket[id]);
  return record && record.id === id ? record : null;
}

function parseCompany(v: unknown): CompanyEntry | null {
  const c = obj(v);
  if (!c) return null;
  const ats = strList(c.ats, 20, 40);
  if (!isStr(c.name) || !isStr(c.domain, 253) || !DOMAIN_RE.test(c.domain) || !isStrOrNull(c.blurb, 2000) || !ats) return null;
  if (!isStrOrNull(c.careers_url, 2048)) return null;
  if (typeof c.open_count !== 'number' || !Number.isInteger(c.open_count) || c.open_count < 0) return null;
  const careers = c.careers_url && /^https:\/\//i.test(c.careers_url) ? c.careers_url : null;
  return { name: c.name, domain: c.domain, blurb: c.blurb, ats, careers_url: careers, open_count: c.open_count };
}

/** Parses the companies file, keeping only well-formed entries with slug-shaped keys. */
export function parseCompanies(v: unknown): Companies {
  const map = obj(v);
  if (!map) return {};
  const entries: Array<[string, CompanyEntry]> = [];
  for (const [slug, entry] of Object.entries(map)) {
    if (!SLUG_RE.test(slug)) continue;
    const c = parseCompany(entry);
    if (c) entries.push([slug, c]);
  }
  return Object.fromEntries(entries);
}

export async function loadCompanies(fetchFn: typeof fetch = fetch): Promise<Companies> {
  const res = await fetchFn('/data/companies.json');
  if (!res.ok) return {};
  return parseCompanies(await res.json());
}

const PERIOD_LABEL: Record<NonNullable<Salary['period']>, string> = {
  hour: 'hour', day: 'day', week: 'week', month: 'month', year: 'year',
};

function money(n: number, currency: string): string {
  const code = /^[A-Z]{3}$/.test(currency) ? currency : 'USD';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: code, maximumFractionDigits: Number.isInteger(n) ? 0 : 2,
    }).format(n);
  } catch {
    return `${code} ${n}`;
  }
}

/** "$45–$55 / hour", "$120,000 / year", "" when nothing usable. */
export function salaryLabel(salary: Salary | null): string {
  if (!salary) return '';
  const { min, max, currency, period } = salary;
  let amount: string;
  if (min !== null && max !== null) amount = min === max ? money(min, currency) : `${money(min, currency)}–${money(max, currency)}`;
  else if (min !== null) amount = `from ${money(min, currency)}`;
  else if (max !== null) amount = `up to ${money(max, currency)}`;
  else return '';
  return period ? `${amount} / ${PERIOD_LABEL[period]}` : amount;
}

/**
 * "Posted 2 h ago by employer" when the ATS gave a timestamp, "Posted 3 d ago
 * (date from Workday)" for text-derived dates, "First seen 2 h ago" otherwise.
 */
export function postedLabel(record: Pick<JobRecord, 'posted_at' | 'posted_at_source' | 'first_seen_at'>, now: number): string {
  switch (record.posted_at_source) {
    case 'ATS_FIELD':
      return `Posted ${relativeTime(record.posted_at, now)} by employer`;
    case 'WORKDAY_TEXT':
      return `Posted ${relativeTime(record.posted_at, now)} (date from Workday)`;
    case 'FIRST_SEEN':
      return `First seen ${relativeTime(record.first_seen_at, now)}`;
  }
}

/** Hostname for the "You are leaving for …" safety line; '' when the URL is unusable. */
export function applyHostLabel(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return '';
    return u.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export const GITHUB_REPO = 'https://github.com/alterj07/walkpath';

export function reportUrl(id: string): string {
  const safe = ID_RE.test(id) ? id : 'unknown';
  return `${GITHUB_REPO}/issues/new?template=report-listing.yml&title=${encodeURIComponent(`listing: ${safe}`)}`;
}
