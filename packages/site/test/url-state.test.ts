import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTERS, filtersEqual, filtersToSearch, parseFilters, serializeFilters } from '../src/lib/url-state.ts';

describe('parseFilters', () => {
  it('returns defaults for an empty query', () => {
    expect(parseFilters(new URLSearchParams(''))).toEqual(DEFAULT_FILTERS);
  });

  it('parses every known key and validates values', () => {
    const f = parseFilters(new URLSearchParams(
      'window=7d&family=swe,software_engineering,data_ml_ai&state=tx,CA,ZZ&arr=remote,bogus&season=Summer 2027,Immediate,Nope 2027&nocit=1&company=SpaceX&q=embedded&page=3',
    ));
    expect(f.window).toBe('7d');
    expect(f.family).toEqual(['software_engineering', 'data_ml_ai']);
    expect(f.state).toEqual(['TX', 'CA']);
    expect(f.arr).toEqual(['remote']);
    expect(f.season).toEqual(['Summer 2027', 'Immediate']);
    expect(f.nocit).toBe(true);
    expect(f.company).toBe('SpaceX');
    expect(f.q).toBe('embedded');
    expect(f.page).toBe(3);
  });

  it('falls back on bad window, page and oversized text', () => {
    const f = parseFilters(new URLSearchParams(`window=1y&page=-2&q=${'a'.repeat(300)}`));
    expect(f.window).toBe('24h');
    expect(f.page).toBe(1);
    expect(f.q).toHaveLength(100);
    expect(parseFilters(new URLSearchParams('page=abc')).page).toBe(1);
    expect(parseFilters(new URLSearchParams('page=5000')).page).toBe(1);
  });

  it('dedupes csv values and caps list length', () => {
    const many = Array.from({ length: 60 }, () => 'CA').join(',');
    expect(parseFilters(new URLSearchParams(`state=${many}`)).state).toEqual(['CA']);
    const states = Object.keys({ AL: 1, AK: 1, AZ: 1, AR: 1, CA: 1, CO: 1, CT: 1, DE: 1, FL: 1, GA: 1, HI: 1, ID: 1, IL: 1, IN: 1, IA: 1, KS: 1, KY: 1, LA: 1, ME: 1, MD: 1, MA: 1, MI: 1, MN: 1, MS: 1 });
    expect(parseFilters(new URLSearchParams(`state=${states.join(',')}`)).state.length).toBeLessThanOrEqual(20);
  });

  it('collapses whitespace in text fields', () => {
    expect(parseFilters(new URLSearchParams('q=  machine   learning ')).q).toBe('machine learning');
  });
});

describe('serializeFilters', () => {
  it('omits defaults and round-trips', () => {
    expect(serializeFilters(DEFAULT_FILTERS).toString()).toBe('');
    expect(filtersToSearch(DEFAULT_FILTERS)).toBe('');
    const f = { ...DEFAULT_FILTERS, window: '3d' as const, family: ['product' as const], state: ['NY'], nocit: true, q: 'c++', page: 2 };
    const s = serializeFilters(f).toString();
    expect(s).toBe('window=3d&family=product&state=NY&nocit=1&q=c%2B%2B&page=2');
    expect(parseFilters(new URLSearchParams(s))).toEqual(f);
    expect(filtersToSearch(f)).toBe(`?${s}`);
  });

  it('compares filters by their serialized form', () => {
    expect(filtersEqual(DEFAULT_FILTERS, { ...DEFAULT_FILTERS, page: 1 })).toBe(true);
    expect(filtersEqual(DEFAULT_FILTERS, { ...DEFAULT_FILTERS, window: '1h' })).toBe(false);
  });
});
