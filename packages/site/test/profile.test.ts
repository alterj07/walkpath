import { beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_PROFILE, PROFILE_KEY, clearProfile, getProfile, hasProfile, sanitizeProfile, saveProfile } from '../src/lib/profile.ts';

const store = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

beforeEach(() => {
  store.clear();
  (globalThis as unknown as { localStorage: typeof fakeStorage }).localStorage = fakeStorage;
});

describe('profile store', () => {
  it('returns an empty profile when nothing is stored', () => {
    expect(getProfile()).toEqual(EMPTY_PROFILE);
    expect(hasProfile(getProfile())).toBe(false);
  });

  it('round-trips a saved profile with a timestamp', () => {
    const saved = saveProfile({ ...EMPTY_PROFILE, grad_year: 2030, skills: ['Python', 'python', 'C++'], families: ['software_engineering'] }, new Date('2026-10-10T00:00:00Z'));
    expect(saved.updated_at).toBe('2026-10-10T00:00:00.000Z');
    expect(saved.skills).toEqual(['Python', 'C++']);
    expect(getProfile()).toEqual(saved);
    expect(store.has(PROFILE_KEY)).toBe(true);
    clearProfile();
    expect(getProfile()).toEqual(EMPTY_PROFILE);
  });

  it('drops hostile or malformed values on read', () => {
    const p = sanitizeProfile({
      grad_year: '2030',
      degree_level: 'doctorate',
      enrolled: 'yes',
      majors: ['x'.repeat(100), 'Computer Science', 5],
      skills: Array.from({ length: 200 }, (_, i) => `s${i}`),
      families: ['software_engineering', 'evil'],
      states: ['CA', 'ca', 'California'],
      remote_ok: 'true',
      citizen: 1,
      needs_sponsorship: null,
      updated_at: 'not a date',
      __proto__: { polluted: true },
      extra: 'field',
    });
    expect(p.grad_year).toBeNull();
    expect(p.degree_level).toBeNull();
    expect(p.enrolled).toBeNull();
    expect(p.majors).toEqual(['Computer Science']);
    expect(p.skills).toHaveLength(100);
    expect(p.families).toEqual(['software_engineering']);
    expect(p.states).toEqual(['CA']);
    expect(p.remote_ok).toBe(true);
    expect(p.citizen).toBeNull();
    expect(p.updated_at).toBe('');
    expect(Object.keys(p)).not.toContain('extra');
    expect(Object.getPrototypeOf(p)).toBe(Object.prototype);
  });

  it('survives a corrupt store', () => {
    store.set(PROFILE_KEY, '{not json');
    expect(getProfile()).toEqual(EMPTY_PROFILE);
  });
});
