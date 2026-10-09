/**
 * Build-time helpers for the pre-rendered category pages and the sitemap
 * (plan sections 2.5 and 5.5). The publish job writes `public/data/pages.json`
 * and `public/data/index/all.json` before `astro build`; in dev the committed
 * samples are used. Everything read from disk goes through the same guards as
 * the runtime loaders, so a malformed entry is dropped, never rendered.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAMILIES, FAMILY_LABELS, US_STATES, parseIndexFile } from './data.ts';
import type { Family, IndexRow } from './data.ts';
import { DEFAULT_FILTERS, SEASON_RE, filtersToSearch } from './url-state.ts';
import type { ExploreFilters } from './url-state.ts';

export const PAGE_KINDS = ['family', 'family_season', 'family_remote', 'state', 'company'] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

export interface PageFilter {
  family?: Family;
  season?: string;
  remote?: boolean;
  state?: string;
  slug?: string;
}

export interface PagesEntry {
  slug: string;
  title: string;
  kind: PageKind;
  filter: PageFilter;
}

export interface BuildData {
  pages: PagesEntry[];
  rows: IndexRow[];
  generatedAt: string;
}

export const KIND_LABELS: Record<PageKind, string> = {
  family: 'By role family',
  family_season: 'By role family and season',
  family_remote: 'Remote, by role family',
  state: 'By state',
  company: 'By company',
};

/** Pages with fewer open internships than this are rendered with noindex. */
export const THIN_PAGE_MIN = 5;
/** Rows rendered inline on a category page. */
export const PAGE_ROW_LIMIT = 50;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

function isStr(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

/** Type guard for one pages.json entry; unknown keys in `filter` are ignored. */
export function isPagesEntry(v: unknown): v is PagesEntry {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (!isStr(o.slug, 80) || !SLUG_RE.test(o.slug) || !isStr(o.title, 120)) return false;
  if (!(PAGE_KINDS as readonly string[]).includes(o.kind as string)) return false;
  const f = o.filter;
  if (typeof f !== 'object' || f === null) return false;
  const r = f as Record<string, unknown>;
  if (r.family !== undefined && !(FAMILIES as readonly string[]).includes(r.family as string)) return false;
  if (r.season !== undefined && !(typeof r.season === 'string' && SEASON_RE.test(r.season))) return false;
  if (r.remote !== undefined && typeof r.remote !== 'boolean') return false;
  if (r.state !== undefined && !(typeof r.state === 'string' && r.state in US_STATES)) return false;
  if (r.slug !== undefined && !(typeof r.slug === 'string' && SLUG_RE.test(r.slug))) return false;
  return true;
}

/** Parses pages.json, keeping valid entries with unique slugs in file order. */
export function parsePages(v: unknown): PagesEntry[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: PagesEntry[] = [];
  for (const e of v) {
    if (!isPagesEntry(e) || seen.has(e.slug)) continue;
    seen.add(e.slug);
    const f = e.filter;
    const filter: PageFilter = {};
    if (f.family !== undefined) filter.family = f.family;
    if (f.season !== undefined) filter.season = f.season;
    if (f.remote !== undefined) filter.remote = f.remote;
    if (f.state !== undefined) filter.state = f.state;
    if (f.slug !== undefined) filter.slug = f.slug;
    out.push({ slug: e.slug, title: e.title, kind: e.kind, filter });
  }
  return out;
}

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'data');

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** Reads pages.json and index/all.json at build time. Missing files yield empty data. */
export function loadBuildData(dir: string = dataDir): BuildData {
  const pages = parsePages(readJson(join(dir, 'pages.json')));
  const index = parseIndexFile(readJson(join(dir, 'index', 'all.json')));
  return { pages, rows: index.rows, generatedAt: index.generated_at };
}

/** Rows matching a page's filter, newest first. The index holds open rows only. */
export function rowsForPage(rows: readonly IndexRow[], entry: PagesEntry): IndexRow[] {
  const f = entry.filter;
  const out = rows.filter((r) => {
    if (f.family !== undefined && r.family !== f.family) return false;
    if (f.season !== undefined && r.season !== f.season) return false;
    if (f.remote && r.arrangement !== 'remote') return false;
    if (f.state !== undefined && r.state !== f.state) return false;
    if (f.slug !== undefined && r.slug !== f.slug) return false;
    return true;
  });
  out.sort((a, b) => b.posted_at.localeCompare(a.posted_at) || b.first_seen_at.localeCompare(a.first_seen_at));
  return out;
}

export interface PageStats {
  open: number;
  companies: number;
  medianHoursSincePosted: number | null;
}

/** Open count, distinct companies, and the median age of the postings at `generatedAt`. */
export function pageStats(rows: readonly IndexRow[], generatedAt: string): PageStats {
  const now = Date.parse(generatedAt);
  const companies = new Set(rows.map((r) => r.slug)).size;
  const ages = rows
    .map((r) => now - Date.parse(r.posted_at))
    .filter((ms) => Number.isFinite(ms) && ms >= 0)
    .sort((a, b) => a - b);
  let median: number | null = null;
  if (ages.length > 0) {
    const mid = Math.floor(ages.length / 2);
    const ms = ages.length % 2 === 1 ? ages[mid]! : (ages[mid - 1]! + ages[mid]!) / 2;
    median = Math.round(ms / 3_600_000);
  }
  return { open: rows.length, companies, medianHoursSincePosted: median };
}

export function shouldNoindex(rows: readonly IndexRow[]): boolean {
  return rows.length < THIN_PAGE_MIN;
}

/**
 * schema.org ItemList of the page's rows. Only ListItem url + name: job pages
 * are noindex, so no JobPosting entities. Serialized with `<` escaped so the
 * JSON can never close the surrounding script element.
 */
export function itemListJsonLd(entry: PagesEntry, rows: readonly IndexRow[], siteUrl: string): string {
  const base = siteUrl.replace(/\/+$/, '');
  const doc = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `${entry.title} internships`,
    url: `${base}/internships/${entry.slug}`,
    numberOfItems: rows.length,
    itemListElement: rows.slice(0, PAGE_ROW_LIMIT).map((r, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: `${base}/job/${r.id}`,
      name: `${r.title} at ${r.company}`,
    })),
  };
  // U+2028/U+2029 are line terminators in JavaScript but not in JSON; escape
  // them too so the block is safe inside any script-reading tooling.
  const lineSeps = new RegExp(`${String.fromCharCode(0x2028)}|${String.fromCharCode(0x2029)}`, 'g');
  return JSON.stringify(doc)
    .replace(/</g, '\\u003c')
    .replace(lineSeps, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
}

/** Pages of the same kind, or sharing the same family, excluding the page itself. */
export function siblingLinks(entry: PagesEntry, pages: readonly PagesEntry[]): PagesEntry[] {
  return pages.filter(
    (p) =>
      p.slug !== entry.slug &&
      (p.kind === entry.kind || (entry.filter.family !== undefined && p.filter.family === entry.filter.family)),
  );
}

/** The explore-page URL that applies the same filter (window widened to 30 days). */
export function exploreHref(entry: PagesEntry): string {
  const f = entry.filter;
  const filters: ExploreFilters = {
    ...DEFAULT_FILTERS,
    window: '30d',
    family: f.family !== undefined ? [f.family] : [],
    state: f.state !== undefined ? [f.state] : [],
    arr: f.remote ? ['remote'] : [],
    season: f.season !== undefined ? [f.season] : [],
    company: entry.kind === 'company' ? entry.title : '',
  };
  return `/${filtersToSearch(filters)}`;
}

/** Human description used in the meta description and the stats strip. */
export function describePage(entry: PagesEntry, stats: PageStats): string {
  const parts = [`${stats.open} open ${stats.open === 1 ? 'internship' : 'internships'}`];
  if (stats.companies > 0) parts.push(`${stats.companies} ${stats.companies === 1 ? 'company' : 'companies'}`);
  if (stats.medianHoursSincePosted !== null) parts.push(`median ${stats.medianHoursSincePosted} h since posting`);
  const what = entry.filter.family !== undefined ? FAMILY_LABELS[entry.filter.family] : entry.title;
  return `${what} internships in the US: ${parts.join(', ')}. Polled hourly from employers' own job boards.`;
}
