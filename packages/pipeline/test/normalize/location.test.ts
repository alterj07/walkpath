import { describe, expect, it } from 'vitest';
import { parseLocation } from '../../src/normalize/location.ts';
import { usCities } from '../../src/data/us-gazetteer.ts';

const cases: Array<[string, Partial<ReturnType<typeof parseLocation>>]> = [
  ['Littleton, Colorado', { city: 'Littleton', state: 'CO', country: 'US', remote: false, matched: true }],
  ['Littleton, CO', { city: 'Littleton', state: 'CO', country: 'US' }],
  ['San Francisco, CA, United States', { city: 'San Francisco', state: 'CA', country: 'US' }],
  ['Remote - US', { city: null, state: null, country: 'US', remote: true }],
  ['Remote (United States)', { city: null, state: null, country: 'US', remote: true }],
  ['Remote in USA', { country: 'US', remote: true }],
  ['Remote', { city: null, state: null, country: null, remote: true }],
  ['United States', { city: null, state: null, country: 'US', remote: false }],
  ['Multiple Locations', { city: null, state: null, country: null, multiple: true }],
  ['New York, NY / Austin, TX', { city: 'New York City', state: 'NY', country: 'US', multiple: true }],
  ['Boston, MA | Remote', { city: 'Boston', state: 'MA', multiple: true, remote: true }],
  ['US-CA-Sunnyvale', { city: 'Sunnyvale', state: 'CA', country: 'US' }],
  ['Sunnyvale, California, US', { city: 'Sunnyvale', state: 'CA', country: 'US' }],
  ['London, UK', { city: null, state: null, country: 'other' }],
  ['London', { country: 'other' }],
  ['Toronto, ON, Canada', { country: 'other' }],
  ['Remote in Canada', { country: 'other', remote: true }],
  ['Dubai - United Arab Emirates', { country: 'other' }],
  ['Portland', { city: 'Portland', state: 'OR', country: 'US', matched: true }],
  ['Portland, ME', { city: 'Portland', state: 'ME' }],
  ['Portland, OR 97201', { city: 'Portland', state: 'OR' }],
  ['Springfield', { city: 'Springfield', state: 'MO' }],
  ['Washington, D.C.', { city: 'Washington', state: 'DC' }],
  ['Washington', { city: null, state: 'WA', country: 'US' }],
  ['NYC', { city: 'New York City', state: 'NY' }],
  ['SF', { city: 'San Francisco', state: 'CA' }],
  ['New York', { city: 'New York City', state: 'NY' }],
  ['New York, New York', { city: 'New York City', state: 'NY' }],
  ['Texas', { city: null, state: 'TX', country: 'US' }],
  ['Cambridge, MA', { city: 'Cambridge', state: 'MA' }],
  ['Hybrid - Seattle, WA', { city: 'Seattle', state: 'WA' }],
  ['Mountain View, CA (Hybrid)', { city: 'Mountain View', state: 'CA' }],
  ['Boston, Massachusetts, United States of America', { city: 'Boston', state: 'MA', country: 'US' }],
  ['Greater Seattle Area', { city: 'Seattle', state: 'WA' }],
  ['Austin', { city: 'Austin', state: 'TX', country: 'US' }],
  ['Nowhereville, CA', { city: 'Nowhereville', state: 'CA', country: 'US', matched: false }],
  ['', { city: null, state: null, country: null }],
];

describe('parseLocation', () => {
  for (const [raw, expected] of cases) {
    it(`parses ${JSON.stringify(raw)}`, () => {
      expect(parseLocation(raw)).toMatchObject(expected);
    });
  }

  it('leaves small ambiguous city names unresolved without a state', () => {
    // "Franklin" exists in many states and none is >= 100k.
    const r = parseLocation('Franklin');
    expect(r.city).toBeNull();
    expect(r.state).toBeNull();
  });

  it('handles null and undefined', () => {
    expect(parseLocation(null).city).toBeNull();
    expect(parseLocation(undefined).country).toBeNull();
  });
});

describe('gazetteer', () => {
  it('loads thousands of US cities with population >= 10k', () => {
    const cities = usCities();
    expect(cities.length).toBeGreaterThan(4000);
    expect(cities.every((c) => c.population >= 10_000 && /^[A-Z]{2}$/.test(c.state))).toBe(true);
  });
});
