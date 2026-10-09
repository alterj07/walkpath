import { describe, expect, it } from 'vitest';
import { resolveApplyUrl } from '../../src/publish/apply-url.ts';

const base = { companyDomain: 'rocketlabcorp.com', careersUrl: 'https://www.rocketlabcorp.com/careers/' } as const;

describe('resolveApplyUrl', () => {
  it.each([
    ['greenhouse', 'https://boards.greenhouse.io/rocketlab/jobs/1?gh_src=abc&utm_source=x'],
    ['greenhouse', 'https://job-boards.greenhouse.io/rocketlab/jobs/1'],
    ['lever', 'https://jobs.lever.co/palantir/abc/apply'],
    ['lever', 'https://jobs.eu.lever.co/octoenergy/abc'],
    ['ashby', 'https://jobs.ashbyhq.com/ramp/123/application'],
    ['workable', 'https://apply.workable.com/tmeic/j/ABC123/'],
    ['smartrecruiters', 'https://jobs.smartrecruiters.com/BoschGroup/744000'],
    ['workday', 'https://rocketlab.wd1.myworkdayjobs.com/en-US/Rocket_Lab/job/JR-1'],
  ] as const)('accepts %s host %s', (ats, url) => {
    const r = resolveApplyUrl({ applyUrl: url, ats, ...base });
    expect(r.apply_url_downgraded).toBe(false);
    expect(r.apply_url.startsWith('https://')).toBe(true);
    expect(r.apply_url).not.toContain('utm_');
    expect(r.apply_url).not.toContain('gh_src');
    expect(r.flagged_reason).toBeUndefined();
  });

  it('accepts the company domain and its subdomains', () => {
    const r = resolveApplyUrl({ applyUrl: 'https://careers.rocketlabcorp.com/job/1', ats: 'greenhouse', ...base });
    expect(r).toEqual({ apply_url: 'https://careers.rocketlabcorp.com/job/1', apply_url_downgraded: false });
  });

  it('upgrades http to https', () => {
    const r = resolveApplyUrl({ applyUrl: 'http://boards.greenhouse.io/x/jobs/1', ats: 'greenhouse', ...base });
    expect(r.apply_url).toBe('https://boards.greenhouse.io/x/jobs/1');
    expect(r.apply_url_downgraded).toBe(false);
  });

  it('downgrades an off-host apply URL to the careers page and flags it', () => {
    const r = resolveApplyUrl({ applyUrl: 'https://g00gle-careers.com/apply', ats: 'greenhouse', ...base });
    expect(r).toEqual({
      apply_url: 'https://www.rocketlabcorp.com/careers/',
      apply_url_downgraded: true,
      flagged_reason: 'apply_url:off_host',
    });
  });

  it('prefers the hosted URL over the careers page when the apply URL is bad', () => {
    const r = resolveApplyUrl({
      applyUrl: 'javascript:alert(1)',
      hostedUrl: 'https://boards.greenhouse.io/rocketlab/jobs/1',
      ats: 'greenhouse',
      ...base,
    });
    expect(r.apply_url).toBe('https://boards.greenhouse.io/rocketlab/jobs/1');
    expect(r.apply_url_downgraded).toBe(false);
    expect(r.flagged_reason).toBe('apply_url:scheme');
  });

  it.each([
    ['javascript:alert(1)', 'scheme'],
    ['data:text/html;base64,PHNjcmlwdD4=', 'scheme'],
    ['https://bit.ly/abc', 'shortener'],
    ['https://1.2.3.4/apply', 'ip_literal'],
    ['https://evil.com@boards.greenhouse.io/x', 'userinfo'],
    ['not a url', 'unparseable'],
    ['', 'missing'],
  ])('rejects %s (%s) and falls back to careers', (url, reason) => {
    const r = resolveApplyUrl({ applyUrl: url, ats: 'greenhouse', ...base });
    expect(r.apply_url_downgraded).toBe(true);
    expect(r.apply_url).toBe('https://www.rocketlabcorp.com/careers/');
    expect(r.flagged_reason).toBe(`apply_url:${reason}`);
  });

  it('rejects URLs over 2,048 characters before validating them', () => {
    const long = 'https://boards.greenhouse.io/rocketlab/jobs/1?x=' + 'a'.repeat(2100);
    const r = resolveApplyUrl({ applyUrl: long, ats: 'greenhouse', ...base });
    expect(r.apply_url_downgraded).toBe(true);
    expect(r.flagged_reason).toBe('apply_url:too_long');
    const longCareers = resolveApplyUrl({ applyUrl: 'javascript:x', ats: 'greenhouse', companyDomain: 'acme.com', careersUrl: 'https://acme.com/?' + 'b'.repeat(2100) });
    expect(longCareers.apply_url).toBe('');
  });

  it('does not match a look-alike of the wildcard ATS host', () => {
    const r = resolveApplyUrl({ applyUrl: 'https://evilmyworkdayjobs.com/x', ats: 'workday', ...base });
    expect(r.apply_url_downgraded).toBe(true);
  });

  it('uses only the company domain for an unknown ats', () => {
    const ok = resolveApplyUrl({ applyUrl: 'https://rocketlabcorp.com/x', ats: 'jsonld', ...base });
    expect(ok.apply_url_downgraded).toBe(false);
    const bad = resolveApplyUrl({ applyUrl: 'https://boards.greenhouse.io/x', ats: 'jsonld', ...base });
    expect(bad.apply_url_downgraded).toBe(true);
  });

  it('returns an empty url when even the careers url is unusable', () => {
    const r = resolveApplyUrl({ applyUrl: 'https://evil.example/x', ats: 'lever', companyDomain: 'acme.com', careersUrl: 'javascript:x' });
    expect(r).toEqual({ apply_url: '', apply_url_downgraded: true, flagged_reason: 'apply_url:off_host;careers_url:unusable' });
    const none = resolveApplyUrl({ applyUrl: 'https://evil.example/x', ats: 'lever' });
    expect(none.apply_url).toBe('');
  });
});
