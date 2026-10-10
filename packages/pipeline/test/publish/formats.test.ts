import { describe, expect, it } from 'vitest';
import {
  BucketFileSchema,
  CompaniesFileSchema,
  IndexFileSchema,
  IndexRowSchema,
  MetaSchema,
  PagesFileSchema,
  bucketOf,
  toIndexRow,
} from '../../src/publish/formats.ts';
import { makeRecord } from './record-fixture.ts';

describe('formats', () => {
  it('projects a record onto an index row', () => {
    const row = toIndexRow(makeRecord({ location: { raw: 'x', city: 'Austin', state: 'TX', country: 'US', arrangement: 'hybrid', others: ['Denver, CO', 'Seattle, WA'] } }));
    expect(row).toEqual({
      id: 'a9f3c2e17b04',
      title: 'Flight Software Intern Summer 2027',
      company: 'Rocket Lab',
      slug: 'rocket-lab',
      domain: 'rocketlabcorp.com',
      city: 'Austin',
      state: 'TX',
      arrangement: 'hybrid',
      family: 'hardware_embedded',
      kind: 'internship',
      season: 'Summer 2027',
      posted_at: '2026-10-09T14:14:00.000Z',
      first_seen_at: '2026-10-09T14:31:07.000Z',
      ats: 'greenhouse',
      has_salary: true,
      citizenship_required: true,
      others: 2,
    });
    expect(IndexRowSchema.parse(row)).toEqual(row);
    expect(toIndexRow(makeRecord({ salary: null })).has_salary).toBe(false);
    // Plan 5.1 budgets ~300 bytes per row; this record is a long-title worst case.
    expect(JSON.stringify(row).length).toBeLessThan(440);
  });

  it('round-trips the index, bucket, companies and pages files', () => {
    const rec = makeRecord();
    const index = { generated_at: rec.last_seen_at, rows: [toIndexRow(rec)] };
    expect(IndexFileSchema.parse(JSON.parse(JSON.stringify(index)))).toEqual(index);
    const bucket = { [rec.id]: rec };
    expect(BucketFileSchema.parse(JSON.parse(JSON.stringify(bucket)))).toEqual(bucket);
    expect(() => BucketFileSchema.parse({ 'not-hex': rec })).toThrow();
    const companies = { 'rocket-lab': { name: 'Rocket Lab', domain: 'rocketlabcorp.com', blurb: null, ats: ['greenhouse'], careers_url: null, open_count: 3 } };
    expect(CompaniesFileSchema.parse(companies)).toEqual(companies);
    const pages = [
      { slug: 'software-engineering-internships', title: 'Software Engineering Internships', kind: 'family', filter: { family: 'software_engineering' } },
      { slug: 'internships-tx', title: 'Tech Internships in Texas', kind: 'state', filter: { state: 'TX' } },
    ];
    expect(PagesFileSchema.parse(pages)).toEqual(pages);
    expect(() => PagesFileSchema.parse([{ ...pages[0], slug: 'Bad Slug' }])).toThrow();
  });

  it('round-trips meta.json', () => {
    const meta = {
      last_run_at: '2026-10-09T15:17:40.000Z',
      run_id: 'api-20261009T1517',
      boards: { greenhouse: { polled: 100, ok: 98, failed: 2 } },
      jobs: { open: 3000, new: 40, closed: 12 },
      latency: { median_min: 31.5, p90_min: null },
      llm: { mistral: { requests: 40, tokens: 96000 } },
      pending_summaries: 0,
      held_for_review: 2,
      schedule: { started_at: '2026-10-09T15:17:03.000Z', lateness_min: 0.05 },
    };
    expect(MetaSchema.parse(JSON.parse(JSON.stringify(meta)))).toEqual(meta);
    expect(() => MetaSchema.parse({ ...meta, jobs: { open: -1, new: 0, closed: 0 } })).toThrow();
  });

  it('buckets by the first two hex characters', () => {
    expect(bucketOf('a9f3c2e17b04')).toBe('a9');
  });
});
