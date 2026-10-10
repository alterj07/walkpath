import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SIMPLIFY_BOARDS,
  SIMPLIFY_MAX_BODY_BYTES,
  SIMPLIFY_POLICY,
  simplifyAdapter,
  simplifyDescriptionHtml,
  simplifyListUrl,
  stripSimplifyTracking,
  type SimplifyRawJob,
} from '../../src/adapters/simplify.ts';
import { HttpClient, type FetchLike } from '../../src/http/client.ts';
import { BoardSchema, type Board } from '../../src/schema/board.ts';
import { JobPostingInputSchema } from '../../src/schema/job.ts';
import { resolveApplyUrl } from '../../src/publish/apply-url.ts';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'simplify');
const fixture = (name: string) => readFileSync(join(fixtures, name), 'utf8');
const FIRST_SEEN = new Date('2026-10-10T03:00:00.000Z');

function board(key: string): Board {
  return BoardSchema.parse({
    company_slug: 'simplifyjobs',
    company_name: 'SimplifyJobs lists',
    domain: '',
    ats: 'simplify',
    board_key: key,
    wd: '',
    careers_url: `https://github.com/${SIMPLIFY_BOARDS[key]?.repo ?? 'SimplifyJobs'}`,
    added_at: '2026-10-10',
    status: 'active',
  });
}

function fakeHttp(routes: Record<string, { status?: number; body: string }>) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404 });
    const status = route.status ?? 200;
    return new Response(status === 304 ? null : route.body, { status });
  };
  return { http: new HttpClient({ fetch: fetchImpl, respectRobots: false, sleep: async () => undefined }), calls };
}

const INTERN_URL = simplifyListUrl('summer-internships');
const NEWGRAD_URL = simplifyListUrl('new-grad-positions');

describe('simplify adapter', () => {
  it('builds list URLs for the two known boards and rejects others', () => {
    expect(INTERN_URL).toBe('https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json');
    expect(NEWGRAD_URL).toBe('https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json');
    expect(() => simplifyListUrl('other')).toThrow(/unknown board_key/);
    expect(SIMPLIFY_POLICY.allowedHosts).toContain('raw.githubusercontent.com');
    expect(SIMPLIFY_POLICY.allowedHosts).toContain('simplify.jobs');
    expect(SIMPLIFY_MAX_BODY_BYTES).toBeGreaterThan(13 * 1024 * 1024);
  });

  it('lists only active, visible rows with one request per board', async () => {
    const { http, calls } = fakeHttp({ [INTERN_URL]: { body: fixture('intern.json') } });
    const jobs = await simplifyAdapter.listJobs(board('summer-internships'), http);
    expect(calls).toEqual([INTERN_URL]);
    expect(jobs.length).toBe(6); // 8 rows in the fixture: one inactive, one invisible
    expect(jobs.every((j) => j.boardKey === 'summer-internships')).toBe(true);
    expect(jobs.every((j) => j.active === true && j.is_visible !== false)).toBe(true);
  });

  it('returns [] on 304 and throws a body-free error on a malformed list', async () => {
    const notModified = fakeHttp({ [NEWGRAD_URL]: { status: 304, body: '' } });
    expect(await simplifyAdapter.listJobs(board('new-grad-positions'), notModified.http)).toEqual([]);
    const bad = fakeHttp({ [NEWGRAD_URL]: { body: JSON.stringify([{ title: 'no id', url: 'https://x.example' }]) } });
    await expect(simplifyAdapter.listJobs(board('new-grad-positions'), bad.http)).rejects.toThrow(/simplify:new-grad-positions list: unexpected payload shape/);
    await expect(simplifyAdapter.listJobs(board('new-grad-positions'), bad.http)).rejects.not.toThrow(/x\.example/);
  });

  it('maps a listing into a JobPostingInput with the employer name, employment type and posting time', async () => {
    const { http } = fakeHttp({ [INTERN_URL]: { body: fixture('intern.json') } });
    const jobs = await simplifyAdapter.listJobs(board('summer-internships'), http);
    const hermeus = jobs.find((j) => j.company_name === 'Hermeus');
    expect(hermeus).toBeDefined();
    const input = simplifyAdapter.toInput(hermeus!, board('summer-internships'), FIRST_SEEN);
    expect(JobPostingInputSchema.safeParse(input).success).toBe(true);
    expect(input.companyName).toBe('Hermeus');
    expect(input.companyUrl).toBeUndefined(); // the fixture row has an empty company_url
    expect(input.employmentType).toBe('Internship');
    expect(input.title).toBe('Flight Software Engineering Intern');
    expect(input.locations).toEqual(['Atlanta, GA']);
    expect(input.postedAtSource).toBe('ATS_FIELD');
    expect(input.postedAt).toBe(new Date((hermeus!.date_posted ?? 0) * 1000).toISOString());
    expect(input.applyUrl).toMatch(/^https:\/\/jobs\.lever\.co\/hermeus\//);
    expect(input.descriptionHtml).toContain('Listed on the SimplifyJobs Summer Internships list');
    expect(input.descriptionHtml).toContain('U.S. Citizenship is Required');
    expect(simplifyAdapter.canonicalKey(hermeus!, board('summer-internships'))).toBe(`simplify:summer-internships:${hermeus!.id}`);
  });

  it('marks new-grad rows and multi-location rows, and uses first-seen when the list has no time', () => {
    const base: SimplifyRawJob = {
      id: 'abc',
      company_name: 'Honeywell',
      title: 'Hardware Engineer 1',
      active: true,
      is_visible: true,
      url: 'https://example.com/jobs/1',
      locations: ['Clearwater, FL', 'Minneapolis, MN', ''],
      date_posted: null,
      date_updated: null,
      boardKey: 'new-grad-positions',
    };
    const input = simplifyAdapter.toInput(base, board('new-grad-positions'), FIRST_SEEN);
    expect(input.employmentType).toBe('New Grad');
    expect(input.locations).toEqual(['Clearwater, FL', 'Minneapolis, MN']);
    expect(input.postedAt).toBe(FIRST_SEEN.toISOString());
    expect(input.postedAtSource).toBe('FIRST_SEEN');
    expect(simplifyAdapter.parsePostedAt(base, FIRST_SEEN)).toBeNull();
    const remote = simplifyAdapter.toInput({ ...base, locations: ['Remote in USA'] }, board('new-grad-positions'), FIRST_SEEN);
    expect(remote.remoteFlag).toBe(true);
  });

  it('strips only SimplifyJobs attribution parameters from apply URLs', () => {
    expect(stripSimplifyTracking('https://jobs.lever.co/x/1?utm_source=Simplify&ref=Simplify&keep=1')).toBe('https://jobs.lever.co/x/1?keep=1');
    expect(stripSimplifyTracking('https://jobs.lever.co/x/1?ref=linkedin')).toBe('https://jobs.lever.co/x/1?ref=linkedin');
    expect(stripSimplifyTracking('not a url')).toBe('not a url');
  });

  it('publishes list apply URLs on any https host, with simplify.jobs redirects accepted', async () => {
    const { http } = fakeHttp({ [NEWGRAD_URL]: { body: fixture('newgrad.json') } });
    const jobs = await simplifyAdapter.listJobs(board('new-grad-positions'), http);
    for (const raw of jobs) {
      const input = simplifyAdapter.toInput(raw, board('new-grad-positions'), FIRST_SEEN);
      const resolved = resolveApplyUrl({ applyUrl: input.applyUrl, hostedUrl: input.hostedUrl, ats: 'simplify', companyDomain: '', careersUrl: '' });
      expect(resolved.apply_url_downgraded, input.applyUrl).toBe(false);
      expect(resolved.apply_url.startsWith('https://')).toBe(true);
    }
    const redirect = jobs.find((j) => j.url.includes('simplify.jobs/p/'));
    expect(redirect).toBeDefined();
    const hostile = resolveApplyUrl({ applyUrl: 'javascript:alert(1)', ats: 'simplify', companyDomain: '', careersUrl: '' });
    expect(hostile.apply_url_downgraded).toBe(true);
  });

  it('escapes list text in the generated description', () => {
    const html = simplifyDescriptionHtml({
      id: '1',
      title: 't',
      url: 'https://x.example',
      active: true,
      boardKey: 'summer-internships',
      category: '<script>alert(1)</script>',
      terms: ['Summer 2027'],
      degrees: ["Bachelor's"],
      sponsorship: 'Other',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Term: Summer 2027');
    expect(html).not.toContain('Work authorization');
  });
});
