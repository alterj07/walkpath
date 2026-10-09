import { describe, expect, it } from 'vitest';
import {
  parseArrangement,
  parseGradYears,
  parseSalary,
  parseSeason,
  parseWorkAuth,
  stripTags,
} from '../../src/normalize/fields.ts';

describe('parseArrangement', () => {
  it('trusts the ATS remote flag first', () => {
    expect(parseArrangement({ remoteFlag: true, title: 'Onsite Intern' })).toBe('remote');
    expect(parseArrangement({ remoteFlag: false, title: 'Intern' })).toBe('in_person');
  });
  it('reads title and locations', () => {
    expect(parseArrangement({ title: 'Intern', locations: ['Remote - US'] })).toBe('remote');
    expect(parseArrangement({ title: 'Hybrid Intern', locations: ['Austin, TX'] })).toBe('hybrid');
    expect(parseArrangement({ title: 'Intern (On-site)', locations: ['Austin, TX'] })).toBe('in_person');
  });
  it('falls back to the description, then unknown', () => {
    expect(parseArrangement({ title: 'Intern', description: '<p>This role is fully remote.</p>' })).toBe('remote');
    expect(parseArrangement({ title: 'Intern', description: '<p>We work in person in Austin.</p>' })).toBe('in_person');
    expect(parseArrangement({ title: 'Intern', description: '<p>Great team.</p>' })).toBe('unknown');
  });
  it('does not mistake "remote" in a description sentence like "remote sensing" for the arrangement', () => {
    expect(parseArrangement({ title: 'Intern', description: '<p>Work on remote sensing data.</p>' })).toBe('unknown');
  });
});

describe('parseSalary', () => {
  it('prefers a structured range inside sane bounds', () => {
    expect(parseSalary({ structured: { min: 25, max: 40, currency: 'USD', period: 'hour' } })).toEqual({
      min: 25,
      max: 40,
      currency: 'USD',
      period: 'hour',
    });
  });
  it('rejects structured values outside bounds and falls back to text', () => {
    expect(parseSalary({ structured: { min: 2700, max: 2700, currency: 'USD', period: 'hour' }, description: '' })).toBeNull();
  });
  it('parses hourly, yearly and k ranges from text', () => {
    expect(parseSalary({ description: 'Pay Range CO: $27.00 USD Hourly' })).toEqual({ min: 27, max: 27, currency: 'USD', period: 'hour' });
    expect(parseSalary({ description: 'The rate is $30 - $45 per hour depending on year.' })).toEqual({
      min: 30,
      max: 45,
      currency: 'USD',
      period: 'hour',
    });
    expect(parseSalary({ description: 'Compensation: $85k–$110k annually' })).toEqual({ min: 85_000, max: 110_000, currency: 'USD', period: 'year' });
    expect(parseSalary({ description: 'Salary range $95,000 - $120,000' })).toEqual({ min: 95_000, max: 120_000, currency: 'USD', period: 'year' });
    expect(parseSalary({ description: '<p>$7,500/month stipend</p>' })).toEqual({ min: 7500, max: 7500, currency: 'USD', period: 'month' });
  });
  it('ignores non-salary dollar amounts', () => {
    expect(parseSalary({ description: 'We have 3 offices and $5 billion in revenue; $1 fee.' })).toBeNull();
    expect(parseSalary({ description: 'A $2,000 - $3,000 relocation bonus' })).toBeNull();
  });
});

describe('parseSeason', () => {
  it('reads the title first', () => {
    expect(parseSeason('Software Intern Summer 2027')).toBe('Summer 2027');
    expect(parseSeason("Fall '26 Co-op")).toBe('Fall 2026');
    expect(parseSeason('Autumn 2026 Intern')).toBe('Fall 2026');
    expect(parseSeason('2027 Internship - Software')).toBe('Summer 2027');
    expect(parseSeason('Intern - Spring 2027 - Data')).toBe('Spring 2027');
  });
  it('uses a start date when the title has nothing', () => {
    expect(parseSeason('Intern', null, '2027-06-01')).toBe('Summer 2027');
    expect(parseSeason('Intern', null, new Date('2026-09-15T00:00:00Z'))).toBe('Fall 2026');
    expect(parseSeason('Intern', null, '2027-01-10')).toBe('Winter 2027');
  });
  it('falls back to the description and immediate starts', () => {
    expect(parseSeason('Intern', '<p>This internship runs Summer 2027.</p>')).toBe('Summer 2027');
    expect(parseSeason('Intern', 'Start immediately.')).toBe('Immediate');
    expect(parseSeason('Intern', 'No dates here')).toBeNull();
  });
});

describe('parseWorkAuth', () => {
  it('detects citizenship, ITAR and no-sponsorship', () => {
    expect(parseWorkAuth('Must be a U.S. citizen due to ITAR. We will not sponsor visas.')).toMatchObject({
      citizenship_required: true,
      sponsorship: 'no',
    });
    expect(parseWorkAuth('Active security clearance required.').citizenship_required).toBe(true);
    expect(parseWorkAuth('Applicants must be authorized to work in the United States; no visa sponsorship.')).toMatchObject({
      sponsorship: 'no',
    });
  });
  it('detects sponsorship-friendly postings', () => {
    expect(parseWorkAuth('Candidates on OPT/CPT welcome. Visa sponsorship is available.')).toMatchObject({
      citizenship_required: false,
      sponsorship: 'yes',
    });
    expect(parseWorkAuth('U.S. citizens or permanent residents (green card) welcome.').citizenship_required).toBe(false);
  });
  it('returns unknowns for silence', () => {
    expect(parseWorkAuth('<p>Join our team.</p>')).toEqual({ citizenship_required: null, sponsorship: 'unknown', signals: [] });
  });
});

describe('parseGradYears', () => {
  it('reads the common phrasings', () => {
    expect(parseGradYears('Graduating in 2027 or 2028.')).toEqual([2027, 2028]);
    expect(parseGradYears('Class of 2027/2028')).toEqual([2027, 2028]);
    expect(parseGradYears('Expected graduation: May 2027')).toEqual([2027]);
    expect(parseGradYears('graduation date between December 2026 and June 2028')).toEqual([2026, 2028]);
    expect(parseGradYears("class of '27")).toEqual([2027]);
  });
  it('ignores unrelated years', () => {
    expect(parseGradYears('Founded in 2010, revenue 2024')).toEqual([]);
  });
});

describe('stripTags', () => {
  it('removes markup and scripts and decodes entities', () => {
    expect(stripTags('<p>Hi &amp; <script>x()</script><b>there</b> &#8217;</p>')).toBe('Hi & there ’');
  });
});
