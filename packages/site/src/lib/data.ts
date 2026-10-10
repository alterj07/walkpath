/**
 * Runtime data access for the static site. Everything the site reads comes
 * from same-origin JSON files written by the publish job (plan section 5.1).
 * Every value is untrusted at this boundary: rows are checked by hand-rolled
 * guards and malformed rows are dropped.
 */

export const FAMILIES = [
  'software_engineering',
  'data_ml_ai',
  'it_cloud_security',
  'product',
  'ux_design',
  'hardware_embedded',
  'quant_research',
] as const;
export type Family = (typeof FAMILIES)[number];

export const ARRANGEMENTS = ['in_person', 'hybrid', 'remote', 'unknown'] as const;
export type Arrangement = (typeof ARRANGEMENTS)[number];

export const WINDOWS = ['1h', '6h', '24h', '3d', '7d', '30d'] as const;
export type TimeWindow = (typeof WINDOWS)[number];

export type IndexFileName = 'latest' | '7d' | 'all';

export interface IndexRow {
  id: string;
  title: string;
  company: string;
  slug: string;
  domain: string;
  city: string | null;
  state: string | null;
  arrangement: Arrangement;
  family: Family;
  season: string | null;
  posted_at: string;
  first_seen_at: string;
  ats: string;
  has_salary: boolean;
  citizenship_required: boolean | null;
  others: number;
}

export interface IndexFile {
  generated_at: string;
  rows: IndexRow[];
}

export interface Meta {
  last_run_at: string;
  run_id: string;
  boards: Record<string, { polled: number; ok: number; failed: number }>;
  jobs: { open: number; new: number; closed: number };
  latency: { median_min: number | null; p90_min: number | null };
  llm: Record<string, { requests: number; tokens: number }>;
  pending_summaries: number;
  held_for_review: number;
  schedule: { started_at: string; lateness_min: number | null };
}

export const FAMILY_LABELS: Record<Family, string> = {
  software_engineering: 'Software Engineering',
  data_ml_ai: 'Data / ML / AI',
  it_cloud_security: 'IT / Cloud / Security',
  product: 'Product',
  ux_design: 'UX / Design',
  hardware_embedded: 'Hardware / Embedded / EE',
  quant_research: 'Quant / Research',
};

export const ARRANGEMENT_LABELS: Record<Arrangement, string> = {
  in_person: 'In person',
  hybrid: 'Hybrid',
  remote: 'Remote',
  unknown: 'Not specified',
};

export const ATS_LABELS: Record<string, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  workable: 'Workable',
  smartrecruiters: 'SmartRecruiters',
  workday: 'Workday',
  recruitee: 'Recruitee',
  breezy: 'Breezy',
  jsonld: 'careers site',
  simplify: 'SimplifyJobs list',
};

export const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

const ID_RE = /^[a-f0-9]{12}$/;
const MAX_STR = 500;

function isStr(v: unknown, max = MAX_STR): v is string {
  return typeof v === 'string' && v.length <= max;
}
function isStrOrNull(v: unknown): v is string | null {
  return v === null || isStr(v);
}
function isIso(v: unknown): v is string {
  return isStr(v, 40) && !Number.isNaN(Date.parse(v));
}
function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (list as readonly string[]).includes(v);
}

/** Type guard for one index row. Unknown extra keys are ignored. */
export function isIndexRow(v: unknown): v is IndexRow {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    isStr(r.id, 12) && ID_RE.test(r.id) &&
    isStr(r.title) && r.title.length > 0 &&
    isStr(r.company) && isStr(r.slug, 120) && isStr(r.domain, 253) &&
    isStrOrNull(r.city) && isStrOrNull(r.state) &&
    isOneOf(ARRANGEMENTS, r.arrangement) && isOneOf(FAMILIES, r.family) &&
    isStrOrNull(r.season) && isIso(r.posted_at) && isIso(r.first_seen_at) &&
    isStr(r.ats, 40) && typeof r.has_salary === 'boolean' &&
    (r.citizenship_required === null || typeof r.citizenship_required === 'boolean') &&
    typeof r.others === 'number' && Number.isInteger(r.others) && r.others >= 0
  );
}

/** Parses an index file payload, keeping only rows that pass the guard. */
export function parseIndexFile(v: unknown): IndexFile {
  if (typeof v !== 'object' || v === null) return { generated_at: '', rows: [] };
  const o = v as Record<string, unknown>;
  const rows = Array.isArray(o.rows) ? o.rows.filter(isIndexRow) : [];
  // Copy only the known fields so nothing unexpected rides along.
  const clean = rows.map((r) => ({
    id: r.id, title: r.title, company: r.company, slug: r.slug, domain: r.domain,
    city: r.city, state: r.state, arrangement: r.arrangement, family: r.family,
    season: r.season, posted_at: r.posted_at, first_seen_at: r.first_seen_at, ats: r.ats,
    has_salary: r.has_salary, citizenship_required: r.citizenship_required, others: r.others,
  }));
  return { generated_at: isIso(o.generated_at) ? o.generated_at : '', rows: clean };
}

const KEY_RE = /^[a-z0-9_-]{1,40}$/i;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Rebuilds a `{name: {k: number}}` map from untrusted input, keeping only
 * entries whose name is a plain identifier and whose values are all finite
 * numbers. Never returns the parsed object by reference and never copies
 * unknown keys, so `__proto__` or extra fields cannot ride along.
 */
function countRecord<K extends string>(v: unknown, keys: readonly K[]): Record<string, Record<K, number>> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
  const entries: Array<[string, Record<K, number>]> = [];
  for (const [name, e] of Object.entries(v as Record<string, unknown>)) {
    if (!KEY_RE.test(name) || UNSAFE_KEYS.has(name) || typeof e !== 'object' || e === null) continue;
    const src = e as Record<string, unknown>;
    const clean = {} as Record<K, number>;
    let ok = true;
    for (const k of keys) {
      const n = src[k];
      if (typeof n !== 'number' || !Number.isFinite(n)) { ok = false; break; }
      clean[k] = n;
    }
    if (ok) entries.push([name, clean]);
  }
  return Object.fromEntries(entries);
}

export function parseMeta(v: unknown): Meta | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const jobs = o.jobs as Record<string, unknown> | undefined;
  const latency = o.latency as Record<string, unknown> | undefined;
  const schedule = o.schedule as Record<string, unknown> | undefined;
  const numOrNull = (x: unknown): number | null => (typeof x === 'number' ? x : null);
  if (!isIso(o.last_run_at) || !isStr(o.run_id, 120)) return null;
  if (!jobs || typeof jobs.open !== 'number' || typeof jobs.new !== 'number' || typeof jobs.closed !== 'number') return null;
  return {
    last_run_at: o.last_run_at,
    run_id: o.run_id,
    boards: countRecord(o.boards, ['polled', 'ok', 'failed'] as const),
    jobs: { open: jobs.open, new: jobs.new, closed: jobs.closed },
    latency: { median_min: numOrNull(latency?.median_min), p90_min: numOrNull(latency?.p90_min) },
    llm: countRecord(o.llm, ['requests', 'tokens'] as const),
    pending_summaries: typeof o.pending_summaries === 'number' ? o.pending_summaries : 0,
    held_for_review: typeof o.held_for_review === 'number' ? o.held_for_review : 0,
    schedule: {
      started_at: isIso(schedule?.started_at) ? schedule.started_at : o.last_run_at,
      lateness_min: numOrNull(schedule?.lateness_min),
    },
  };
}

export function indexFileFor(window: TimeWindow): IndexFileName {
  switch (window) {
    case '1h':
    case '6h':
    case '24h':
      return 'latest';
    case '3d':
    case '7d':
      return '7d';
    case '30d':
      return 'all';
  }
}

const HOUR = 3_600_000;
const WINDOW_MS: Record<TimeWindow, number> = {
  '1h': HOUR, '6h': 6 * HOUR, '24h': 24 * HOUR, '3d': 72 * HOUR, '7d': 168 * HOUR, '30d': 720 * HOUR,
};

export function windowStartMs(window: TimeWindow, now: number): number {
  return now - WINDOW_MS[window];
}

export async function loadIndexFile(file: IndexFileName, fetchFn: typeof fetch = fetch): Promise<IndexFile> {
  const res = await fetchFn(`/data/index/${file}.json`, { cache: 'default' });
  if (!res.ok) throw new Error(`index ${file}: HTTP ${res.status}`);
  return parseIndexFile(await res.json());
}

export function loadIndex(window: TimeWindow, fetchFn: typeof fetch = fetch): Promise<IndexFile> {
  return loadIndexFile(indexFileFor(window), fetchFn);
}

export async function loadMeta(fetchFn: typeof fetch = fetch): Promise<Meta | null> {
  const res = await fetchFn('/data/meta.json', { cache: 'default' });
  if (!res.ok) return null;
  return parseMeta(await res.json());
}

/** "just now", "5 min ago", "2 h ago", "3 d ago"; absolute dates past 30 days. */
export function relativeTime(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  // A timestamp well in the future is a clock-skew or data bug; show the date.
  if (t - now > 5 * 60_000) return new Date(t).toISOString().slice(0, 10);
  const diff = Math.max(0, now - t);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d <= 30) return `${d} d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/** Absolute, human-readable UTC time for tooltips. */
export function absoluteTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/**
 * Brandfetch Logo Link CDN URL, only when the public client id is configured.
 * The UI falls back to a letter avatar when this returns null.
 */
export function logoUrl(domain: string, clientId?: string | undefined): string | null {
  // Read lazily with optional chaining so plain Node (tests, scripts) never throws.
  const id = clientId ?? (import.meta.env?.PUBLIC_BRANDFETCH_CLIENT_ID as string | undefined);
  if (!id || !/^[A-Za-z0-9_-]{4,64}$/.test(id)) return null;
  if (!/^[a-z0-9.-]{3,253}$/i.test(domain)) return null;
  return `https://cdn.brandfetch.io/${encodeURIComponent(domain.toLowerCase())}?c=${encodeURIComponent(id)}`;
}

export function locationLabel(row: Pick<IndexRow, 'city' | 'state' | 'arrangement'>): string {
  const parts = [row.city, row.state].filter((p): p is string => !!p);
  if (parts.length) return parts.join(', ');
  return row.arrangement === 'remote' ? 'Remote (US)' : 'United States';
}
