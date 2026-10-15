import { describe, expect, it } from 'vitest';
import { boardUrl, fingerprintHtml, fingerprintUrl } from '../../src/registry/fingerprint.ts';

describe('fingerprintUrl', () => {
  it.each([
    // Greenhouse
    ['https://boards.greenhouse.io/intrinsicrobotics/jobs/5795490004', 'greenhouse', 'intrinsicrobotics'],
    ['https://job-boards.greenhouse.io/SuccessKPIinc/jobs/4660222005?gh_src=abc', 'greenhouse', 'successkpiinc'],
    ['https://job-boards.eu.greenhouse.io/wise/', 'greenhouse', 'wise'],
    ['https://boards.greenhouse.io/embed/job_board?for=Stripe', 'greenhouse', 'stripe'],
    ['https://boards.greenhouse.io/embed/job_board/js?for=figma', 'greenhouse', 'figma'],
    ['https://boards-api.greenhouse.io/v1/boards/figma/jobs?content=true', 'greenhouse', 'figma'],
    ['https://stripe.com/jobs/listing/x?gh_jid=123&for=stripe', 'greenhouse', 'stripe'],
    // Lever
    ['https://jobs.lever.co/magnetforensics/17b0e272-6e67-40bb-9373-1d30e4c2ebf5/apply', 'lever', 'magnetforensics'],
    ['https://jobs.lever.co/Palantir', 'lever', 'palantir'],
    ['https://api.lever.co/v0/postings/palantir?mode=json', 'lever', 'palantir'],
    // Lever EU boards are keyed eu:{site}
    ['https://jobs.eu.lever.co/Wise/abc', 'lever', 'eu:wise'],
    ['https://api.eu.lever.co/v0/postings/wise?mode=json', 'lever', 'eu:wise'],
    // Ashby
    ['https://jobs.ashbyhq.com/root-access/31fb07e2-adec-4950-bbba-22cf5b9b1054/application', 'ashby', 'root-access'],
    ['https://jobs.ashbyhq.com/Notion?utm=1', 'ashby', 'notion'],
    ['https://api.ashbyhq.com/posting-api/job-board/ashby?includeCompensation=true', 'ashby', 'ashby'],
    // Workable
    ['https://apply.workable.com/altom-transport/j/89ACE16A43/apply', 'workable', 'altom-transport'],
    ['https://Acme.workable.com/', 'workable', 'acme'],
    ['https://www.workable.com/api/accounts/pony-dot-ai?details=true', 'workable', 'pony-dot-ai'],
    // SmartRecruiters keeps case
    ['https://jobs.smartrecruiters.com/BoschGroup/744000108823061', 'smartrecruiters', 'BoschGroup'],
    ['https://careers.smartrecruiters.com/NBCUniversal3', 'smartrecruiters', 'NBCUniversal3'],
    ['https://api.smartrecruiters.com/v1/companies/smartrecruiters/postings', 'smartrecruiters', 'smartrecruiters'],
    // Subdomain ATSs
    ['https://acme.recruitee.com/o/engineer', 'recruitee', 'acme'],
    ['https://acme.breezy.hr/p/123', 'breezy', 'acme'],
    ['https://acme.pinpointhq.com/postings/1', 'pinpoint', 'acme'],
    ['https://acme.teamtailor.com/jobs', 'teamtailor', 'acme'],
    ['https://acme.jobs.personio.de/job/1', 'personio', 'acme'],
    ['https://acme.jobs.personio.com/', 'personio', 'acme'],
    ['https://acme.bamboohr.com/careers/12', 'bamboohr', 'acme'],
    ['https://acme.applytojob.com/apply/abc', 'jazzhr', 'acme'],
  ])('%s → %s:%s', (url, ats, key) => {
    expect(fingerprintUrl(url)).toMatchObject({ ats, boardKey: key });
  });

  it('parses Workday tenant, data center and site, keeping case', () => {
    expect(
      fingerprintUrl('https://caci.wd1.myworkdayjobs.com/external/job/US-TX-San-Antonio/Software-Engineering-Intern_322038'),
    ).toEqual({ ats: 'workday', boardKey: 'caci/external', meta: { tenant: 'caci', site: 'external', wd: 1 } });
    expect(fingerprintUrl('https://salesforce.wd12.myworkdayjobs.com/External_Career_Site/job/x/y_JR1')).toMatchObject({
      boardKey: 'salesforce/External_Career_Site',
      meta: { wd: 12 },
    });
    // Locale segment before the site, trailing slash.
    expect(fingerprintUrl('https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/')).toMatchObject({
      boardKey: 'nvidia/NVIDIAExternalCareerSite',
    });
    expect(fingerprintUrl('https://rbc.wd3.myworkdayjobs.com/fr-CA/RBCEarlyTalent?q=intern')).toMatchObject({
      boardKey: 'rbc/RBCEarlyTalent',
    });
    // The cxs API path.
    expect(fingerprintUrl('https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs')).toMatchObject({
      boardKey: 'nvidia/NVIDIAExternalCareerSite',
    });
    // myworkdaysite
    expect(fingerprintUrl('https://wd3.myworkdaysite.com/en-US/recruiting/sharp/Sharp_Careers/job/x')).toEqual({
      ats: 'workday',
      boardKey: 'sharp/Sharp_Careers',
      meta: { tenant: 'sharp', site: 'Sharp_Careers', wd: 3, host: 'myworkdaysite' },
    });
    // Tenant host with no site is not enough.
    expect(fingerprintUrl('https://nvidia.wd5.myworkdayjobs.com/')).toBeNull();
    expect(fingerprintUrl('https://nvidia.wd5.myworkdayjobs.com/en-US')).toBeNull();
  });

  it('flags deferred vendors with the vendor name', () => {
    expect(fingerprintUrl('https://careers-gdms.icims.com/jobs/1/job')).toEqual({ ats: 'icims', boardKey: 'careers-gdms' });
    expect(fingerprintUrl('https://university-uber.icims.com/jobs/search?ss=1')).toEqual({ ats: 'icims', boardKey: 'university-uber' });
    expect(fingerprintUrl('https://cdn02.icims.com/a/images.icims.com/x.js')).toBeNull();
    expect(fingerprintUrl('https://acme.taleo.net/careersection/2/jobdetail.ftl')).toMatchObject({ ats: 'deferred', meta: { vendor: 'taleo' } });
    expect(fingerprintUrl('https://jobs.jobvite.com/careers/acme/job/abc')).toEqual({ ats: 'deferred', boardKey: 'acme', meta: { vendor: 'jobvite' } });
    expect(fingerprintUrl('https://jobs.acme.com/search/?q=intern')).toMatchObject({ ats: 'deferred', meta: { vendor: 'successfactors' } });
    expect(fingerprintUrl('https://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX')).toMatchObject({ meta: { vendor: 'oracle' } });
  });

  it('recognises an embedded Greenhouse job without a token as unresolved', () => {
    expect(fingerprintUrl('https://stripe.com/jobs/listing/software-engineer/123?gh_jid=123')).toEqual({
      ats: 'greenhouse',
      boardKey: null,
      meta: { ghJid: '123' },
    });
  });

  it('returns null for unknown hosts, junk and ATS marketing pages', () => {
    expect(fingerprintUrl('https://www.tesla.com/careers/search/job/x-123')).toBeNull();
    expect(fingerprintUrl('https://www.workable.com/')).toBeNull();
    expect(fingerprintUrl('https://jobs.lever.co/')).toBeNull();
    expect(fingerprintUrl('https://jobs.ashbyhq.com/api/non-user-graphql')).toBeNull();
    expect(fingerprintUrl('')).toBeNull();
    expect(fingerprintUrl('not a url')).toBeNull();
    expect(fingerprintUrl('javascript:alert(1)')).toBeNull();
  });

  it('accepts bare hostnames without a scheme', () => {
    expect(fingerprintUrl('jobs.lever.co/acme')).toMatchObject({ ats: 'lever', boardKey: 'acme' });
  });
});

describe('fingerprintHtml', () => {
  it('finds a Greenhouse embed by its for= token', () => {
    const html = `<html><body><script src="https://boards.greenhouse.io/embed/job_board/js?for=Stripe"></script></body></html>`;
    expect(fingerprintHtml(html, 'https://stripe.com/jobs')).toEqual({ ats: 'greenhouse', boardKey: 'stripe' });
  });

  it('finds a Greenhouse iframe', () => {
    const html = `<iframe id="grnhse_iframe" src="https://boards.greenhouse.io/embed/job_board?for=figma&b=https%3A%2F%2Fwww.figma.com%2Fcareers"></iframe>`;
    expect(fingerprintHtml(html, 'https://www.figma.com/careers')).toEqual({ ats: 'greenhouse', boardKey: 'figma' });
  });

  it('finds a Lever embed through a link', () => {
    const html = `<a class="btn" href="https://jobs.lever.co/acme/abc-def">See roles</a>`;
    expect(fingerprintHtml(html, 'https://acme.com/careers')).toMatchObject({ ats: 'lever', boardKey: 'acme' });
  });

  it('finds an Ashby embed by its job board name', () => {
    const html = `<script>window.__ashby_embed = {"jobBoardName": "Notion"}</script><script src="https://jobs.ashbyhq.com/ashby_embed.js"></script>`;
    expect(fingerprintHtml(html, 'https://notion.so/careers')).toEqual({ ats: 'ashby', boardKey: 'notion' });
  });

  it('resolves relative links against the base URL and prefers keyed matches', () => {
    const html = `<a href="/jobs?gh_jid=1">Job</a><iframe src="//boards.greenhouse.io/embed/job_board?for=acme"></iframe>`;
    expect(fingerprintHtml(html, 'https://acme.com/careers')).toEqual({ ats: 'greenhouse', boardKey: 'acme' });
  });

  it('reports an unresolved Greenhouse embed when only gh_jid links exist', () => {
    const html = `<a href="https://stripe.com/jobs/listing/x?gh_jid=123">Job</a>`;
    expect(fingerprintHtml(html, 'https://stripe.com/jobs')).toEqual({ ats: 'greenhouse', boardKey: null, meta: { ghJid: '123' } });
  });

  it('ignores pages with no ATS markers', () => {
    expect(fingerprintHtml('<html><a href="/about">About</a></html>', 'https://acme.com')).toBeNull();
  });
});

describe('boardUrl', () => {
  it('builds the canonical public board URL', () => {
    expect(boardUrl({ ats: 'greenhouse', boardKey: 'figma' })).toBe('https://job-boards.greenhouse.io/figma');
    expect(boardUrl({ ats: 'lever', boardKey: 'eu:acme' })).toBe('https://jobs.eu.lever.co/acme');
    expect(boardUrl({ ats: 'lever', boardKey: 'acme' })).toBe('https://jobs.lever.co/acme');
    expect(boardUrl({ ats: 'workday', boardKey: 'nvidia/NVIDIAExternalCareerSite', meta: { wd: 5 } })).toBe(
      'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite',
    );
    expect(boardUrl({ ats: 'greenhouse', boardKey: null })).toBeNull();
    expect(boardUrl({ ats: 'icims', boardKey: 'careers-x' })).toBe('https://careers-x.icims.com/jobs/search?ss=1');
  });
});
