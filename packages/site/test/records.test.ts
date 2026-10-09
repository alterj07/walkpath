import { describe, expect, it } from 'vitest';
import {
  applyHostLabel,
  bucketOf,
  isJobRecord,
  loadJob,
  parseCompanies,
  parseJobRecord,
  postedLabel,
  reportUrl,
  salaryLabel,
} from '../src/lib/records.ts';

const NOW = Date.parse('2026-10-09T18:00:00Z');

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a9f3c2e17b04',
    title: 'Flight Software Intern Summer 2027',
    title_raw: 'Flight Software Intern Summer 2027',
    company: { slug: 'rocket-lab', name: 'Rocket Lab', domain: 'rocketlabcorp.com' },
    location: { raw: 'Littleton, Colorado', city: 'Littleton', state: 'CO', country: 'US', arrangement: 'in_person', others: [] },
    source: { ats: 'workday', board: 'rocketlab/Rocket_Lab', external_id: 'JR-12345' },
    apply_url: 'https://rocketlab.wd1.myworkdayjobs.com/x',
    apply_url_downgraded: false,
    posted_at: '2026-09-11T14:14:00Z',
    posted_at_source: 'WORKDAY_TEXT',
    first_seen_at: '2026-09-11T14:31:07Z',
    last_seen_at: '2026-10-09T05:17:40Z',
    closed_at: null,
    employment_type: 'internship',
    role_family: 'hardware_embedded',
    season: 'Summer 2027',
    salary: { min: 27, max: 27, currency: 'USD', period: 'hour' },
    citizenship_required: true,
    sponsorship: 'no',
    grad_years: [2027, 2028],
    summary: {
      text: 'Two sentences.',
      responsibilities: ['a'],
      qualifications: ['b'],
      must_have_skills: ['C++', 'Python'],
      nice_to_have_skills: [],
      model: 'mistral/mistral-small-latest',
      generated_at: '2026-09-11T14:33:02Z',
    },
    description_html: '<p>Hello</p>',
    content_hash: '8f1c',
    ...overrides,
  };
}

describe('parseJobRecord', () => {
  it('accepts a well-formed record and copies only known fields', () => {
    const r = parseJobRecord({ ...record(), extra: 'x', __proto__: { evil: 1 } });
    expect(r).not.toBeNull();
    expect(Object.keys(r!)).not.toContain('extra');
    expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
    expect(r!.summary?.must_have_skills).toEqual(['C++', 'Python']);
    expect(isJobRecord(record())).toBe(true);
  });

  it('accepts null salary and null summary', () => {
    expect(parseJobRecord(record({ salary: null, summary: null }))).not.toBeNull();
  });

  it.each([
    ['bad id', { id: 'ZZZ' }],
    ['empty title', { title: '' }],
    ['bad slug', { company: { slug: 'Bad Slug', name: 'x', domain: 'x.com' } }],
    ['bad domain', { company: { slug: 'ok', name: 'x', domain: 'x.com/evil' } }],
    ['bad arrangement', { location: { raw: '', city: null, state: null, country: null, arrangement: 'office', others: [] } }],
    ['non-string others', { location: { raw: '', city: null, state: null, country: null, arrangement: 'remote', others: [1] } }],
    ['bad family', { role_family: 'marketing' }],
    ['bad posted source', { posted_at_source: 'GUESS' }],
    ['bad posted date', { posted_at: 'yesterday' }],
    ['bad sponsorship', { sponsorship: 'maybe' }],
    ['bad grad years', { grad_years: ['2027'] }],
    ['bad salary period', { salary: { min: 1, max: 2, currency: 'USD', period: 'fortnight' } }],
    ['summary list too long', { summary: { text: 't', responsibilities: ['a', 'b', 'c', 'd', 'e', 'f'], qualifications: [], must_have_skills: [], nice_to_have_skills: [], model: 'm', generated_at: '2026-09-11T14:33:02Z' } }],
    ['description not a string', { description_html: { html: '<p>' } }],
    ['missing content hash', { content_hash: undefined }],
    ['non-boolean downgraded flag', { apply_url_downgraded: 'no' }],
  ])('rejects %s', (_name, overrides) => {
    expect(parseJobRecord(record(overrides))).toBeNull();
  });

  it('rejects non-objects', () => {
    expect(parseJobRecord(null)).toBeNull();
    expect(parseJobRecord('x')).toBeNull();
    expect(parseJobRecord([])).toBeNull();
  });
});

describe('loadJob', () => {
  const fetchOk = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });

  it('fetches the bucket for the id and returns the matching record', async () => {
    const calls: string[] = [];
    const f: typeof fetch = async (input) => { calls.push(String(input)); return fetchOk({ a9f3c2e17b04: record() })(); };
    const r = await loadJob('a9f3c2e17b04', f);
    expect(calls).toEqual(['/data/jobs/a9.json']);
    expect(parseJobRecord(record({ company: { slug: 'ok', name: 'x', domain: '' } }))).not.toBeNull();
    expect(r?.title).toBe('Flight Software Intern Summer 2027');
    expect(bucketOf('a9f3c2e17b04')).toBe('a9');
  });

  it('returns null for invalid ids without fetching', async () => {
    let called = false;
    const f: typeof fetch = async () => { called = true; return new Response('{}'); };
    expect(await loadJob('../etc/passwd', f)).toBeNull();
    expect(await loadJob('A9F3C2E17B04', f)).toBeNull();
    expect(called).toBe(false);
  });

  it('returns null on 404, non-object bodies, a missing key or an id mismatch', async () => {
    expect(await loadJob('a9f3c2e17b04', async () => new Response('', { status: 404 }))).toBeNull();
    expect(await loadJob('a9f3c2e17b04', fetchOk([]))).toBeNull();
    expect(await loadJob('a9f3c2e17b04', fetchOk({}))).toBeNull();
    expect(await loadJob('a9f3c2e17b04', fetchOk({ a9f3c2e17b04: record({ id: 'a9f3c2e17b05' }) }))).toBeNull();
  });
});

describe('parseCompanies', () => {
  it('keeps slug-shaped keys with valid entries and drops the rest', () => {
    const c = parseCompanies({
      'rocket-lab': { name: 'Rocket Lab', domain: 'rocketlabcorp.com', blurb: null, ats: ['workday'], careers_url: 'https://rocketlabcorp.com/careers', open_count: 3 },
      'Bad Key': { name: 'x', domain: 'x.com', blurb: null, ats: [], careers_url: null, open_count: 0 },
      'bad-careers': { name: 'x', domain: 'x.com', blurb: null, ats: [], careers_url: 'javascript:alert(1)', open_count: 0 },
      'bad-count': { name: 'x', domain: 'x.com', blurb: null, ats: [], careers_url: null, open_count: -1 },
      'bad-domain': { name: 'x', domain: 'x.com javascript:', blurb: null, ats: [], careers_url: null, open_count: 0 },
      __proto__: { name: 'x', domain: 'x.com', blurb: null, ats: [], careers_url: null, open_count: 0 },
    });
    expect(Object.keys(c).sort()).toEqual(['bad-careers', 'rocket-lab']);
    expect(c['bad-careers']?.careers_url).toBeNull();
    expect(c['rocket-lab']?.open_count).toBe(3);
  });
});

describe('labels', () => {
  it('salaryLabel formats ranges, singles and bounds', () => {
    expect(salaryLabel({ min: 45, max: 55, currency: 'USD', period: 'hour' })).toBe('$45–$55 / hour');
    expect(salaryLabel({ min: 27, max: 27, currency: 'USD', period: 'hour' })).toBe('$27 / hour');
    expect(salaryLabel({ min: 120000, max: 150000, currency: 'USD', period: 'year' })).toBe('$120,000–$150,000 / year');
    expect(salaryLabel({ min: 8000, max: null, currency: 'USD', period: 'month' })).toBe('from $8,000 / month');
    expect(salaryLabel({ min: null, max: 60, currency: 'USD', period: null })).toBe('up to $60');
    expect(salaryLabel({ min: null, max: null, currency: 'USD', period: 'hour' })).toBe('');
    expect(salaryLabel(null)).toBe('');
    expect(salaryLabel({ min: 1, max: 2, currency: 'bad', period: 'hour' })).toBe('$1–$2 / hour');
  });

  it('postedLabel distinguishes employer, Workday-derived and first-seen times', () => {
    const base = { posted_at: '2026-10-09T16:00:00Z', first_seen_at: '2026-10-09T17:30:00Z' };
    expect(postedLabel({ ...base, posted_at_source: 'ATS_FIELD' }, NOW)).toBe('Posted 2 h ago by employer');
    expect(postedLabel({ ...base, posted_at_source: 'WORKDAY_TEXT' }, NOW)).toBe('Posted 2 h ago (date from Workday)');
    expect(postedLabel({ ...base, posted_at_source: 'FIRST_SEEN' }, NOW)).toBe('First seen 30 min ago');
  });

  it('applyHostLabel returns the https hostname without www, else empty', () => {
    expect(applyHostLabel('https://www.careers.rocketlab.com/apply?x=1')).toBe('careers.rocketlab.com');
    expect(applyHostLabel('http://jobs.lever.co/x')).toBe('');
    expect(applyHostLabel('javascript:alert(1)')).toBe('');
    expect(applyHostLabel('')).toBe('');
    expect(applyHostLabel('not a url')).toBe('');
  });

  it('reportUrl encodes the id and never trusts a bad one', () => {
    expect(reportUrl('a9f3c2e17b04')).toBe('https://github.com/alterj07/walkpath/issues/new?template=report-listing.yml&title=listing%3A%20a9f3c2e17b04');
    expect(reportUrl('<script>')).toContain('listing%3A%20unknown');
  });
});
