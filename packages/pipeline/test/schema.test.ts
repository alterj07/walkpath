import { describe, expect, it } from 'vitest';
import { BoardSchema, boardId, JobPostingInputSchema, JobRecordSchema, SeasonSchema } from '../src/schema/index.ts';

describe('BoardSchema', () => {
  const row = {
    company_slug: 'rocket-lab',
    company_name: 'Rocket Lab',
    domain: 'RocketLabCorp.com',
    ats: 'workday',
    board_key: 'rocketlab/Rocket_Lab',
    wd: '1',
    careers_url: 'https://rocketlab.wd1.myworkdayjobs.com/Rocket_Lab',
    added_at: '2026-10-09',
  };
  it('parses a registry row, lowercases the domain, coerces wd, defaults status', () => {
    const b = BoardSchema.parse(row);
    expect(b.domain).toBe('rocketlabcorp.com');
    expect(b.wd).toBe(1);
    expect(b.status).toBe('active');
    expect(boardId(b)).toBe('workday:rocketlab/Rocket_Lab');
  });
  it('requires wd for workday boards and ignores an empty wd column elsewhere', () => {
    const r = BoardSchema.safeParse({ ...row, wd: '' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['wd']);
    const gh = BoardSchema.parse({ ...row, ats: 'greenhouse', board_key: 'rocketlab', wd: '' });
    expect(gh.wd).toBeUndefined();
    expect(BoardSchema.safeParse({ ...row, wd: '0' }).success).toBe(false);
  });
  it('allows an empty domain for unresolved self-hosted boards', () => {
    expect(BoardSchema.parse({ ...row, domain: '' }).domain).toBe('');
    expect(BoardSchema.safeParse({ ...row, domain: 'not a host' }).success).toBe(false);
  });
  it('rejects bad slugs, unknown ATSs and non-http careers urls', () => {
    expect(BoardSchema.safeParse({ ...row, company_slug: 'Rocket Lab' }).success).toBe(false);
    expect(BoardSchema.safeParse({ ...row, ats: 'taleo' }).success).toBe(false);
    expect(BoardSchema.safeParse({ ...row, careers_url: 'javascript:alert(1)' }).success).toBe(false);
  });
});

describe('JobPostingInputSchema', () => {
  it('accepts a minimal adapter output', () => {
    const j = JobPostingInputSchema.parse({
      externalId: '1',
      title: 'Software Engineering Intern',
      descriptionHtml: '<p>hi</p>',
      applyUrl: 'https://boards.greenhouse.io/x/jobs/1',
      postedAt: '2026-10-01T00:00:00.000Z',
      postedAtSource: 'ATS_FIELD',
    });
    expect(j.locations).toEqual([]);
  });
  it('accepts null for the fields ATSs return as null', () => {
    const j = JobPostingInputSchema.parse({
      externalId: '1',
      title: 't',
      descriptionHtml: '',
      applyUrl: 'https://x.y/z',
      postedAt: null,
      postedAtSource: 'FIRST_SEEN',
      internalReqId: null,
      employmentType: null,
      remoteFlag: null,
      hostedUrl: null,
      salary: null,
      department: null,
      applicationDeadline: null,
    });
    expect(j.applicationDeadline).toBeNull();
    expect(j.department).toBeNull();
  });
  it('requires an ISO timestamp or null', () => {
    const base = { externalId: '1', title: 't', descriptionHtml: '', applyUrl: 'https://x.y/z', postedAtSource: 'FIRST_SEEN' };
    expect(JobPostingInputSchema.safeParse({ ...base, postedAt: null }).success).toBe(true);
    expect(JobPostingInputSchema.safeParse({ ...base, postedAt: 'yesterday' }).success).toBe(false);
  });
});

describe('SeasonSchema', () => {
  it('accepts seasons and Immediate only', () => {
    expect(SeasonSchema.safeParse('Summer 2027').success).toBe(true);
    expect(SeasonSchema.safeParse('Immediate').success).toBe(true);
    expect(SeasonSchema.safeParse('summer 2027').success).toBe(false);
  });
});

describe('JobRecordSchema', () => {
  it('validates the published record from the plan', () => {
    const rec = JobRecordSchema.parse({
      id: 'a9f3c2e17b04',
      title: 'Flight Software Intern Summer 2027',
      title_raw: 'Flight Software Intern Summer 2027',
      company: { slug: 'rocket-lab', name: 'Rocket Lab', domain: 'rocketlabcorp.com' },
      location: { raw: 'Littleton, Colorado', city: 'Littleton', state: 'CO', country: 'US', arrangement: 'in_person' },
      source: { ats: 'workday', board: 'rocketlab/wd1/Rocket_Lab', external_id: 'JR-12345' },
      apply_url: 'https://rocketlab.wd1.myworkdayjobs.com/x',
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
      summary: null,
      description_html: '<p>...</p>',
      content_hash: '8f1c8f1c8f1c8f1c8f1c8f1c8f1c8f1c',
    });
    expect(rec.apply_url_downgraded).toBe(false);
    expect(rec.location.others).toEqual([]);
  });
});
