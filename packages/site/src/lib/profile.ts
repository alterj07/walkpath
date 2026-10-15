/**
 * The visitor's profile for deterministic matching (docs/matching.md). Lives in
 * localStorage only; the accounts feature may sync the same key, so PROFILE_KEY is
 * exported for its SYNCED_KEYS list. Every read is validated; every access is in
 * try/catch, so a missing or hostile store never breaks a page.
 */
import { FAMILIES, type Family } from './data.ts';
import type { MatchProfile } from './match.ts';

export const PROFILE_KEY = 'walkpath:profile';
export const DEGREE_LEVELS = ['high_school', 'associate', 'bachelors', 'masters', 'phd'] as const;
export type ProfileDegree = (typeof DEGREE_LEVELS)[number];
export const MAX_SKILLS = 100;
export const MAX_MAJORS = 10;
export const MAX_STATES = 60;
export const STR_MAX = 60;

export interface Profile extends MatchProfile {
  grad_year: number | null;
  degree_level: ProfileDegree | null;
  enrolled: boolean | null;
  majors: string[];
  skills: string[];
  families: Family[];
  states: string[];
  remote_ok: boolean;
  citizen: boolean | null;
  needs_sponsorship: boolean | null;
  updated_at: string;
}

export const EMPTY_PROFILE: Profile = {
  grad_year: null,
  degree_level: null,
  enrolled: null,
  majors: [],
  skills: [],
  families: [],
  states: [],
  remote_ok: true,
  citizen: null,
  needs_sponsorship: null,
  updated_at: '',
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function cleanString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  let out = '';
  for (const ch of v) {
    const c = ch.charCodeAt(0);
    if (c < 32) continue;
    out += ch;
  }
  out = out.trim();
  return out.length === 0 || out.length > STR_MAX ? null : out;
}

function cleanList(v: unknown, max: number, allowed?: readonly string[]): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    const s = cleanString(item);
    if (s === null) continue;
    if (allowed && !allowed.includes(s)) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function boolOrNull(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/** Validates any value into a Profile, dropping everything unexpected. */
export function sanitizeProfile(v: unknown): Profile {
  if (typeof v !== 'object' || v === null) return { ...EMPTY_PROFILE };
  const o = v as Record<string, unknown>;
  const gradYear = typeof o.grad_year === 'number' && Number.isInteger(o.grad_year) && o.grad_year >= 2000 && o.grad_year <= 2100 ? o.grad_year : null;
  const degree = (DEGREE_LEVELS as readonly string[]).includes(String(o.degree_level)) ? (o.degree_level as ProfileDegree) : null;
  const states = cleanList(o.states, MAX_STATES).filter((s) => /^[A-Z]{2}$/.test(s));
  const updated = typeof o.updated_at === 'string' && !Number.isNaN(Date.parse(o.updated_at)) ? new Date(o.updated_at).toISOString() : '';
  return {
    grad_year: gradYear,
    degree_level: degree,
    enrolled: boolOrNull(o.enrolled),
    majors: cleanList(o.majors, MAX_MAJORS),
    skills: cleanList(o.skills, MAX_SKILLS),
    families: cleanList(o.families, FAMILIES.length, FAMILIES) as Family[],
    states,
    remote_ok: typeof o.remote_ok === 'boolean' ? o.remote_ok : true,
    citizen: boolOrNull(o.citizen),
    needs_sponsorship: boolOrNull(o.needs_sponsorship),
    updated_at: updated,
  };
}

export function getProfile(): Profile {
  try {
    const raw = storage()?.getItem(PROFILE_KEY);
    if (!raw) return { ...EMPTY_PROFILE };
    return sanitizeProfile(JSON.parse(raw));
  } catch {
    return { ...EMPTY_PROFILE };
  }
}

export function saveProfile(p: Profile, now: Date = new Date()): Profile {
  const clean = sanitizeProfile({ ...p, updated_at: now.toISOString() });
  try {
    storage()?.setItem(PROFILE_KEY, JSON.stringify(clean));
  } catch {
    // Storage unavailable: the page keeps working with the in-memory profile.
  }
  notifyChanged();
  return clean;
}

export function clearProfile(): void {
  try {
    storage()?.removeItem(PROFILE_KEY);
  } catch {
    // ignore
  }
  notifyChanged();
}

/** Lets the account sync layer know a synced key changed (it listens for this event). */
function notifyChanged(): void {
  try {
    globalThis.dispatchEvent?.(new CustomEvent('walkpath:changed', { detail: { key: PROFILE_KEY } }));
  } catch {
    // No DOM (tests, SSR): nothing to notify.
  }
}

/** True when the profile carries anything a matcher can act on. */
export function hasProfile(p: Profile): boolean {
  return (
    p.grad_year !== null || p.degree_level !== null || p.skills.length > 0 || p.families.length > 0 ||
    p.states.length > 0 || p.citizen !== null || p.needs_sponsorship !== null || p.enrolled !== null
  );
}
