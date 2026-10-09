/**
 * The explore table's state lives in the URL query string so links are
 * shareable and back/forward reproduce the view (plan section 5.2).
 * Pure functions; every value is validated against the allowed sets.
 */
import { ARRANGEMENTS, FAMILIES, US_STATES, WINDOWS } from './data.ts';
import type { Arrangement, Family, TimeWindow } from './data.ts';

export interface ExploreFilters {
  window: TimeWindow;
  family: Family[];
  state: string[];
  arr: Arrangement[];
  season: string[];
  nocit: boolean;
  company: string;
  q: string;
  page: number;
}

export const DEFAULT_FILTERS: ExploreFilters = {
  window: '24h',
  family: [],
  state: [],
  arr: [],
  season: [],
  nocit: false,
  company: '',
  q: '',
  page: 1,
};

export const SEASON_RE = /^(Summer|Fall|Spring|Winter) 20\d\d$|^Immediate$/;
const MAX_TEXT = 100;
const MAX_LIST = 20;

function csv(params: URLSearchParams, key: string): string[] {
  const raw = params.get(key);
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const v = part.trim();
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

function text(params: URLSearchParams, key: string): string {
  const raw = params.get(key) ?? '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

export function parseFilters(params: URLSearchParams): ExploreFilters {
  const window = params.get('window');
  const page = Number.parseInt(params.get('page') ?? '1', 10);
  return {
    window: (WINDOWS as readonly string[]).includes(window ?? '') ? (window as TimeWindow) : DEFAULT_FILTERS.window,
    family: csv(params, 'family').filter((f): f is Family => (FAMILIES as readonly string[]).includes(f)),
    state: csv(params, 'state').map((s) => s.toUpperCase()).filter((s) => s in US_STATES),
    arr: csv(params, 'arr').filter((a): a is Arrangement => (ARRANGEMENTS as readonly string[]).includes(a)),
    season: csv(params, 'season').filter((s) => SEASON_RE.test(s)),
    nocit: params.get('nocit') === '1',
    company: text(params, 'company'),
    q: text(params, 'q'),
    page: Number.isInteger(page) && page >= 1 && page <= 1000 ? page : 1,
  };
}

/** Serializes only non-default values, in a stable key order. */
export function serializeFilters(f: ExploreFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.window !== DEFAULT_FILTERS.window) p.set('window', f.window);
  if (f.family.length) p.set('family', f.family.join(','));
  if (f.state.length) p.set('state', f.state.join(','));
  if (f.arr.length) p.set('arr', f.arr.join(','));
  if (f.season.length) p.set('season', f.season.join(','));
  if (f.nocit) p.set('nocit', '1');
  if (f.company) p.set('company', f.company);
  if (f.q) p.set('q', f.q);
  if (f.page > 1) p.set('page', String(f.page));
  return p;
}

export function filtersToSearch(f: ExploreFilters): string {
  const s = serializeFilters(f).toString();
  return s ? `?${s}` : '';
}

export function filtersEqual(a: ExploreFilters, b: ExploreFilters): boolean {
  return serializeFilters(a).toString() === serializeFilters(b).toString();
}
