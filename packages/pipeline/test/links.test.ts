import { describe, expect, it } from 'vitest';
import { hostMatchesPattern, isAllowedApplyHost, validateApplyUrl } from '../src/links.ts';

describe('validateApplyUrl', () => {
  it('accepts a clean https url', () => {
    expect(validateApplyUrl('https://boards.greenhouse.io/figma/jobs/123')).toEqual({
      ok: true,
      url: 'https://boards.greenhouse.io/figma/jobs/123',
      needsUpgrade: false,
    });
  });

  it('flags http for upgrade and returns the https form', () => {
    const r = validateApplyUrl('http://jobs.lever.co/x/abc');
    expect(r).toEqual({ ok: true, url: 'https://jobs.lever.co/x/abc', needsUpgrade: true });
  });

  it.each([
    ['javascript:alert(1)', 'scheme'],
    ['data:text/html,<script>alert(1)</script>', 'scheme'],
    ['mailto:hr@example.com', 'scheme'],
    ['tel:+15555555555', 'scheme'],
    ['ftp://example.com/x', 'scheme'],
    ['https://user:pass@example.com/apply', 'userinfo'],
    ['https://user@example.com/apply', 'userinfo'],
    ['https://192.168.0.1/apply', 'ip_literal'],
    ['https://[::1]/apply', 'ip_literal'],
    ['https://bit.ly/abc', 'shortener'],
    ['https://www.tinyurl.com/abc', 'shortener'],
    ['https://lnkd.in/abc', 'shortener'],
    ['https://t.ly/abc', 'shortener'],
    ['https://rebrand.ly/abc', 'shortener'],
    ['not a url', 'unparseable'],
    ['', 'unparseable'],
  ])('rejects %s (%s)', (input, reason) => {
    expect(validateApplyUrl(input)).toEqual({ ok: false, reason });
  });

  it('strips tracking params and fragments but keeps routing params', () => {
    const r = validateApplyUrl(
      'https://careers.example.com/apply?gh_jid=42&utm_source=x&utm_medium=y&gclid=1&fbclid=2&lever-source=z#top',
    );
    expect(r).toEqual({ ok: true, url: 'https://careers.example.com/apply?gh_jid=42', needsUpgrade: false });
  });

  it('strips ref/source only on ATS hosts', () => {
    expect(validateApplyUrl('https://jobs.lever.co/x/1?ref=abc&source=li', { atsHosts: ['jobs.lever.co'] })).toMatchObject({
      url: 'https://jobs.lever.co/x/1',
    });
    expect(validateApplyUrl('https://example.com/apply?ref=abc&source=li', { atsHosts: ['jobs.lever.co'] })).toMatchObject({
      url: 'https://example.com/apply?ref=abc&source=li',
    });
  });
});

describe('hostMatchesPattern', () => {
  it('matches exact hosts case-insensitively', () => {
    expect(hostMatchesPattern('Boards.Greenhouse.io', 'boards.greenhouse.io')).toBe(true);
    expect(hostMatchesPattern('boards.greenhouse.io.evil.com', 'boards.greenhouse.io')).toBe(false);
  });
  it('wildcards match subdomains only', () => {
    expect(hostMatchesPattern('acme.wd5.myworkdayjobs.com', '*.myworkdayjobs.com')).toBe(true);
    expect(hostMatchesPattern('myworkdayjobs.com', '*.myworkdayjobs.com')).toBe(false);
    expect(hostMatchesPattern('notmyworkdayjobs.com', '*.myworkdayjobs.com')).toBe(false);
  });
});

describe('isAllowedApplyHost', () => {
  const atsHosts = ['boards.greenhouse.io', 'job-boards.greenhouse.io'];
  it('accepts ATS hosts and the company domain with subdomains', () => {
    expect(isAllowedApplyHost('https://boards.greenhouse.io/figma/jobs/1', { atsHosts })).toBe(true);
    expect(isAllowedApplyHost('https://www.figma.com/careers/1', { atsHosts, companyDomain: 'figma.com' })).toBe(true);
    expect(isAllowedApplyHost('https://figma.com/careers/1', { atsHosts, companyDomain: 'figma.com' })).toBe(true);
  });
  it('rejects look-alike and unrelated hosts', () => {
    expect(isAllowedApplyHost('https://figma.com.evil.io/x', { atsHosts, companyDomain: 'figma.com' })).toBe(false);
    expect(isAllowedApplyHost('https://g00gle-careers.com/x', { atsHosts, companyDomain: 'google.com' })).toBe(false);
    expect(isAllowedApplyHost('https://evilfigma.com/x', { atsHosts, companyDomain: 'figma.com' })).toBe(false);
    expect(isAllowedApplyHost('garbage', { atsHosts, companyDomain: 'figma.com' })).toBe(false);
    expect(isAllowedApplyHost('https://example.com/x', { atsHosts })).toBe(false);
  });
});
