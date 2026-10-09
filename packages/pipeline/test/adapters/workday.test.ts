import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HttpClient, HttpError, type FetchLike } from '../../src/http/client.ts';
import { JobPostingInputSchema } from '../../src/schema/job.ts';
import type { Board } from '../../src/schema/board.ts';
import {
  WORKDAY_EMPTY_PAGE_RETRY_MS,
  WORKDAY_MAX_PAGES,
  WORKDAY_PAGE_SIZE,
  WORKDAY_POLICY,
  WorkdayListSchema,
  createWorkdayAdapter,
  parseWorkdayPostedOn,
  workdayAdapter,
  workdayDetailUrl,
  workdayExternalId,
  workdayHostedUrl,
  workdayListUrl,
  workdayLocations,
  workdayParts,
  workdayRemoteFlag,
  workdayReqId,
  type WorkdayRawJob,
} from '../../src/adapters/workday.ts';

const FIXTURES = new URL('../fixtures/workday/', import.meta.url);
const fixture = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');

function board(key = 'nvidia/NVIDIAExternalCareerSite', wd = 5): Board {
  return {
    company_slug: 'nvidia',
    company_name: 'NVIDIA',
    domain: 'nvidia.com',
    ats: 'workday',
    board_key: key,
    wd,
    careers_url: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite',
    added_at: '2026-10-09',
    status: 'active',
  };
}

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(handler: (url: string, n: number, init: RequestInit) => Response) {
  const calls: Call[] = [];
  const slept: number[] = [];
  let t = 1_000_000;
  const fetchImpl: FetchLike = async (url, init) => {
    // robots.txt is fetched once per host by the client; keep it out of the call log.
    if (url.endsWith('/robots.txt')) return new Response('not found', { status: 404 });
    calls.push({ url, init });
    return handler(url, calls.length, init);
  };
  const http = new HttpClient({
    fetch: fetchImpl,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    random: () => 0.5,
  });
  const adapter = createWorkdayAdapter({
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
  });
  return { calls, http, adapter, slept };
}

function json(body: string, status = 200): Response {
  return new Response(status === 304 ? null : body, { status, headers: { 'content-type': 'application/json' } });
}

function posting(n: number, extra: Partial<WorkdayRawJob> = {}): WorkdayRawJob {
  return {
    title: `Software Intern ${n}`,
    externalPath: `/job/US-CA-Santa-Clara/Software-Intern-${n}_JR${1000 + n}`,
    locationsText: 'US, CA, Santa Clara',
    postedOn: 'Posted Today',
    bulletFields: [`JR${1000 + n}`],
    ...extra,
  };
}

function page(total: number, postings: WorkdayRawJob[]): string {
  return JSON.stringify({ total, jobPostings: postings, facets: [], userAuthenticated: false });
}

const FIRST_SEEN = new Date('2026-10-09T15:31:07.000Z');

describe('workday adapter: policy and urls', () => {
  it('declares the plan 4.4 policy', () => {
    expect(WORKDAY_POLICY.minDelayMs).toBe(2000);
    expect(WORKDAY_POLICY.maxConcurrencyPerHost).toBe(1);
    expect(WORKDAY_POLICY.allowedHosts).toEqual(['*.myworkdayjobs.com', '*.myworkdaysite.com']);
    expect(workdayAdapter.source).toBe('workday');
  });

  it('builds list, detail and hosted urls from tenant/site + wd', () => {
    const b = board();
    expect(workdayParts(b)).toEqual({ tenant: 'nvidia', site: 'NVIDIAExternalCareerSite', host: 'nvidia.wd5.myworkdayjobs.com' });
    expect(workdayListUrl(b)).toBe('https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs');
    expect(workdayDetailUrl(b, '/job/UK-Cambridge/X_JR1')).toBe(
      'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/UK-Cambridge/X_JR1',
    );
    expect(workdayHostedUrl(b, '/job/UK-Cambridge/X_JR1')).toBe('https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/UK-Cambridge/X_JR1');
    expect(workdayParts(board('3i/Direct_Hire', 103)).host).toBe('3i.wd103.myworkdayjobs.com');
  });

  it('rejects malformed board keys and a missing wd', () => {
    expect(() => workdayListUrl(board('nvidia'))).toThrow(/tenant\/site/);
    expect(() => workdayListUrl(board('nvidia/site/extra'))).toThrow(/tenant\/site/);
    expect(() => workdayListUrl(board('nvi dia/site'))).toThrow(/tenant\/site/);
    const noWd = { ...board(), wd: undefined } as Board;
    expect(() => workdayListUrl(noWd)).toThrow(/wd column/);
  });

  it('extracts external and requisition ids from the external path', () => {
    expect(workdayExternalId('/job/US-CA-Santa-Clara/Software-Intern_JR1988888')).toBe('JR1988888');
    expect(workdayExternalId('/job/GBR---Gosport-UK/Commercial-Intern_JR2026522032-1')).toBe('JR2026522032-1');
    expect(workdayExternalId('/job/Houston-Texas-US/Engineering-Product-Manager_2022755-1')).toBe('2022755-1');
    expect(workdayExternalId('/job/no-underscore-here')).toBe('/job/no-underscore-here');
    expect(workdayExternalId('/job/trailing_')).toBe('/job/trailing_');
    expect(workdayReqId(posting(1, { bulletFields: ['JR2026522032'], externalPath: '/job/x/Y_JR2026522032-1' }))).toBe('JR2026522032');
    expect(workdayReqId(posting(1, { bulletFields: null, externalPath: '/job/x/Y_JR2026522032-1' }))).toBe('JR2026522032');
    expect(workdayReqId(posting(1, { bulletFields: ['Full time'], externalPath: '/job/x/Y_2022755-1' }))).toBe('2022755');
    expect(workdayReqId(posting(1, { bulletFields: null, externalPath: '/job/plain' }))).toBeNull();
  });
});

describe('workday adapter: postedOn parsing (plan 3.2)', () => {
  it('maps every phrase with a fixed first-seen time', () => {
    expect(parseWorkdayPostedOn('Posted Today', FIRST_SEEN)?.toISOString()).toBe('2026-10-09T15:31:07.000Z');
    expect(parseWorkdayPostedOn('Posted Yesterday', FIRST_SEEN)?.toISOString()).toBe('2026-10-08T00:00:00.000Z');
    expect(parseWorkdayPostedOn('Posted 3 Days Ago', FIRST_SEEN)?.toISOString()).toBe('2026-10-06T00:00:00.000Z');
    expect(parseWorkdayPostedOn('Posted 1 Day Ago', FIRST_SEEN)?.toISOString()).toBe('2026-10-08T00:00:00.000Z');
    expect(parseWorkdayPostedOn('Posted 30+ Days Ago', FIRST_SEEN)?.toISOString()).toBe('2026-09-09T00:00:00.000Z');
    expect(parseWorkdayPostedOn('posted  today ', FIRST_SEEN)?.toISOString()).toBe(FIRST_SEEN.toISOString());
  });

  it('is relative to now, not first-seen, so posted_at is stable across runs', () => {
    const firstSeen = new Date('2026-10-01T09:00:00.000Z');
    const day0 = parseWorkdayPostedOn('Posted Today', firstSeen, new Date('2026-10-01T15:00:00.000Z'));
    expect(day0?.toISOString()).toBe('2026-10-01T09:00:00.000Z');
    // Eight days later the same posting says "Posted 8 Days Ago": the date must not move.
    const day8 = parseWorkdayPostedOn('Posted 8 Days Ago', firstSeen, new Date('2026-10-09T15:00:00.000Z'));
    expect(day8?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    // "Posted Today" for a job first seen on an earlier day means today 00:00Z, not the old first-seen.
    const stale = parseWorkdayPostedOn('Posted Today', firstSeen, new Date('2026-10-09T15:00:00.000Z'));
    expect(stale?.toISOString()).toBe('2026-10-09T00:00:00.000Z');
    const yesterday = parseWorkdayPostedOn('Posted Yesterday', firstSeen, new Date('2026-10-09T15:00:00.000Z'));
    expect(yesterday?.toISOString()).toBe('2026-10-08T00:00:00.000Z');
  });

  it('returns null for localized, missing or odd text', () => {
    expect(parseWorkdayPostedOn('Publié aujourd’hui', FIRST_SEEN)).toBeNull();
    expect(parseWorkdayPostedOn('Posted on 2026-10-01', FIRST_SEEN)).toBeNull();
    expect(parseWorkdayPostedOn('', FIRST_SEEN)).toBeNull();
    expect(parseWorkdayPostedOn(null, FIRST_SEEN)).toBeNull();
    expect(parseWorkdayPostedOn(undefined, FIRST_SEEN)).toBeNull();
  });

  it('parsePostedAt prefers the detail text, takes now, and does not mutate first-seen', () => {
    const seen = new Date(FIRST_SEEN);
    const raw = posting(1, { postedOn: 'Posted Today', detail: { postedOn: 'Posted 2 Days Ago' } });
    expect(workdayAdapter.parsePostedAt(raw, seen)?.toISOString()).toBe('2026-10-07T00:00:00.000Z');
    expect(workdayAdapter.parsePostedAt(raw, seen, new Date('2026-10-20T01:00:00.000Z'))?.toISOString()).toBe('2026-10-18T00:00:00.000Z');
    expect(seen.getTime()).toBe(FIRST_SEEN.getTime());
  });

  it('toInput takes now and keeps the derived date stable while N increments', () => {
    const firstSeen = new Date('2026-10-01T09:00:00.000Z');
    const a = workdayAdapter.toInput(posting(1, { postedOn: 'Posted 3 Days Ago' }), board(), firstSeen, new Date('2026-10-04T10:00:00.000Z'));
    const b = workdayAdapter.toInput(posting(1, { postedOn: 'Posted 4 Days Ago' }), board(), firstSeen, new Date('2026-10-05T10:00:00.000Z'));
    expect(a.postedAt).toBe('2026-10-01T00:00:00.000Z');
    expect(b.postedAt).toBe(a.postedAt);
    expect(a.postedAtSource).toBe('WORKDAY_TEXT');
  });
});

describe('workday adapter: listJobs', () => {
  it('posts the documented body and pages 20 at a time until a short page', async () => {
    const pages = [
      page(45, Array.from({ length: 20 }, (_, i) => posting(i))),
      page(45, Array.from({ length: 20 }, (_, i) => posting(20 + i))),
      page(45, Array.from({ length: 5 }, (_, i) => posting(40 + i))),
    ];
    const { calls, http, adapter } = fakeFetch((_url, n) => json(pages[n - 1] ?? page(45, [])));
    const jobs = await adapter.listJobs(board(), http);
    expect(jobs).toHaveLength(45);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toBe('https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs');
    expect(calls[0]?.init.method).toBe('POST');
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('accept')).toBe('application/json');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ appliedFacets: {}, limit: WORKDAY_PAGE_SIZE, offset: 0, searchText: '' });
    expect(JSON.parse(String(calls[2]?.init.body)).offset).toBe(40);
  });

  it('stops when offset reaches total even on a full page', async () => {
    const pages = [page(40, Array.from({ length: 20 }, (_, i) => posting(i))), page(40, Array.from({ length: 20 }, (_, i) => posting(20 + i)))];
    const { calls, http, adapter } = fakeFetch((_url, n) => json(pages[n - 1] ?? page(40, [])));
    expect(await adapter.listJobs(board(), http)).toHaveLength(40);
    expect(calls).toHaveLength(2);
  });

  it('dedupes a posting shifted across pages', async () => {
    const first = Array.from({ length: 20 }, (_, i) => posting(i));
    const second = [posting(19), ...Array.from({ length: 4 }, (_, i) => posting(20 + i))];
    const pages = [page(25, first), page(25, second)];
    const { http, adapter } = fakeFetch((_url, n) => json(pages[n - 1] ?? page(25, [])));
    expect((await adapter.listJobs(board(), http)).map((j) => j.externalPath)).toHaveLength(24);
  });

  it('retries an empty page before total once after 5 s, then fails the fetch', async () => {
    const { calls, http, adapter, slept } = fakeFetch((_url, n) =>
      json(n === 1 ? page(30, Array.from({ length: 20 }, (_, i) => posting(i))) : page(30, [])),
    );
    await expect(adapter.listJobs(board(), http)).rejects.toThrow('workday:nvidia/NVIDIAExternalCareerSite: empty page before total');
    expect(calls).toHaveLength(3);
    expect(slept).toEqual([WORKDAY_EMPTY_PAGE_RETRY_MS]);
    expect(JSON.parse(String(calls[2]?.init.body)).offset).toBe(20);
  });

  it('recovers when the retried page comes back with data', async () => {
    const { calls, http, adapter } = fakeFetch((_url, n) => {
      if (n === 1) return json(page(25, Array.from({ length: 20 }, (_, i) => posting(i))));
      if (n === 2) return json(page(25, []));
      return json(page(25, Array.from({ length: 5 }, (_, i) => posting(20 + i))));
    });
    expect(await adapter.listJobs(board(), http)).toHaveLength(25);
    expect(calls).toHaveLength(3);
  });

  it('re-fetches the current page once when total grows mid-crawl', async () => {
    const { calls, http, adapter } = fakeFetch((_url, n) => {
      if (n === 1) return json(page(21, Array.from({ length: 20 }, (_, i) => posting(i))));
      if (n === 2) return json(page(22, [posting(19), posting(20)])); // total grew: re-fetch offset 20
      return json(page(22, [posting(19), posting(20), posting(21)]));
    });
    const jobs = await adapter.listJobs(board(), http);
    expect(calls).toHaveLength(3);
    expect(JSON.parse(String(calls[2]?.init.body)).offset).toBe(20);
    expect(jobs).toHaveLength(22);
  });

  it('treats an empty board as empty, not as a throttle', async () => {
    const { calls, http, adapter } = fakeFetch(() => json(page(0, [])));
    expect(await adapter.listJobs(board(), http)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('caps paging at WORKDAY_MAX_PAGES', async () => {
    const huge = WORKDAY_PAGE_SIZE * (WORKDAY_MAX_PAGES + 5);
    const { calls, http, adapter } = fakeFetch((_url, n) =>
      json(page(huge, Array.from({ length: 20 }, (_, i) => posting((n - 1) * 20 + i)))),
    );
    await expect(adapter.listJobs(board(), http)).rejects.toThrow(`paging exceeded ${WORKDAY_MAX_PAGES} pages`);
    expect(calls).toHaveLength(WORKDAY_MAX_PAGES);
  });

  it('returns [] on 304', async () => {
    const { http, adapter } = fakeFetch(() => json('', 304));
    expect(await adapter.listJobs(board(), http)).toEqual([]);
  });

  it('fails with a body-free message on an unexpected shape', async () => {
    const { http, adapter } = fakeFetch(() => json(JSON.stringify({ total: 'many', jobPostings: [{ externalPath: 1 }], secret: 'do-not-print' })));
    await expect(adapter.listJobs(board(), http)).rejects.toThrow(/^workday:nvidia\/NVIDIAExternalCareerSite list offset 0: unexpected payload shape: /);
    await expect(adapter.listJobs(board(), http)).rejects.not.toThrow(/do-not-print/);
  });

  it('surfaces 403 as HttpError(forbidden) before any JSON parsing', async () => {
    const { http, adapter } = fakeFetch(() => new Response('<html>challenge</html>', { status: 403, headers: { 'content-type': 'text/html' } }));
    await expect(adapter.listJobs(board(), http)).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    await expect(adapter.listJobs(board(), http)).rejects.toBeInstanceOf(HttpError);
  });

  it('parses every recorded list fixture', () => {
    for (const tenant of ['nvidia', 'boeing', 'cisco']) {
      const parsed = WorkdayListSchema.parse(JSON.parse(fixture(`${tenant}-list.json`)));
      expect(parsed.jobPostings?.length).toBe(5);
      for (const p of parsed.jobPostings ?? []) expect(workdayExternalId(p.externalPath)).not.toBe(p.externalPath);
    }
  });
});

describe('workday adapter: fetchDetail and toInput', () => {
  it('merges the detail response and maps a recorded intern posting', async () => {
    const listFixture = WorkdayListSchema.parse(JSON.parse(fixture('nvidia-list.json')));
    const raw: WorkdayRawJob = {
      ...listFixture.jobPostings![0]!,
      title: 'CPU Compiler Intern - 2027',
      externalPath: '/job/UK-Cambridge/CPU-Compiler-Intern---2027_JR2027251',
      locationsText: 'UK, Cambridge',
      postedOn: 'Posted Today',
      bulletFields: ['JR2027251'],
    };
    const { calls, http, adapter } = fakeFetch(() => json(fixture('nvidia-detail.json')));
    const withDetail = await adapter.fetchDetail!(board(), raw, http);
    expect(calls[0]?.url).toBe(
      'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/UK-Cambridge/CPU-Compiler-Intern---2027_JR2027251',
    );
    expect(calls[0]?.init.method ?? 'GET').toBe('GET');
    expect(withDetail.detail?.jobReqId).toBe('JR2027251');
    expect(withDetail.detail?.startDate).toBe('2026-10-09');

    const input = adapter.toInput(withDetail, board(), FIRST_SEEN);
    expect(JobPostingInputSchema.parse(input)).toEqual(input);
    expect(input.externalId).toBe('JR2027251');
    expect(input.internalReqId).toBe('JR2027251');
    expect(input.title).toBe('CPU Compiler Intern - 2027');
    expect(input.descriptionHtml).toMatch(/^<p>We are looking for an energetic intern/);
    expect(input.locations).toEqual(['UK, Cambridge']);
    expect(input.employmentType).toBe('Full time');
    expect(input.remoteFlag).toBeNull();
    expect(input.applyUrl).toBe('https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/UK-Cambridge/CPU-Compiler-Intern---2027_JR2027251');
    expect(input.hostedUrl).toBe(input.applyUrl);
    expect(input.postedAt).toBe(FIRST_SEEN.toISOString());
    expect(input.postedAtSource).toBe('WORKDAY_TEXT');
    expect(input.salary).toBeNull();
    expect(input.department).toBeNull();
    expect(input.applicationDeadline).toBeNull();
    expect(adapter.canonicalKey(withDetail, board())).toBe('workday:nvidia/NVIDIAExternalCareerSite:JR2027251');
  });

  it('maps the boeing and cisco details: deadline, remote type, date-precision posted_at', async () => {
    const boeing = board('boeing/EXTERNAL_CAREERS', 1);
    const rawB = posting(1, { externalPath: '/job/GBR---Prestwick-UK/Engineering-Intern---Summer-2027_JR2026520518', postedOn: 'Posted 25 Days Ago', bulletFields: ['JR2026520518'] });
    const b = fakeFetch(() => json(fixture('boeing-detail.json')));
    const inB = b.adapter.toInput(await b.adapter.fetchDetail!(boeing, rawB, b.http), boeing, FIRST_SEEN);
    expect(inB.applicationDeadline).toBe('2026-10-31T00:00:00.000Z');
    expect(inB.remoteFlag).toBe(false);
    expect(inB.postedAt).toBe('2026-09-14T00:00:00.000Z');
    expect(inB.postedAtSource).toBe('WORKDAY_TEXT');
    expect(inB.locations).toEqual(['GBR - Prestwick, UK']);

    const cisco = board('cisco/cisco_careers', 5);
    const rawC = posting(2, { externalPath: '/job/Milpitas-California-US/Software-Engineer_2024896', postedOn: 'Posted Yesterday', bulletFields: ['2024896'], timeType: 'Full time' });
    const c = fakeFetch(() => json(fixture('cisco-detail.json')));
    const inC = c.adapter.toInput(await c.adapter.fetchDetail!(cisco, rawC, c.http), cisco, FIRST_SEEN);
    expect(inC.remoteFlag).toBe(false); // "Hybrid"
    expect(inC.postedAt).toBe('2026-10-08T00:00:00.000Z');
    // externalUrl uses the site's canonical casing, which differs from the registry key; it is on an allowed host so it wins.
    expect(inC.applyUrl).toBe('https://cisco.wd5.myworkdayjobs.com/Cisco_Careers/job/Milpitas-California-US/Software-Engineer_2024896');
    expect(inC.hostedUrl).toBe('https://cisco.wd5.myworkdayjobs.com/cisco_careers/job/Milpitas-California-US/Software-Engineer_2024896');
  });

  it('maps a light (no detail) posting with first-seen fallback and split locations', () => {
    const raw = posting(3, { postedOn: 'Posté aujourd’hui', locationsText: 'US, CA, Santa Clara | US, TX, Austin; Remote', remoteType: 'Remote Job' });
    const input = workdayAdapter.toInput(raw, board(), FIRST_SEEN);
    expect(input.postedAt).toBe(FIRST_SEEN.toISOString());
    expect(input.postedAtSource).toBe('FIRST_SEEN');
    expect(input.locations).toEqual(['US, CA, Santa Clara', 'US, TX, Austin', 'Remote']);
    expect(input.remoteFlag).toBe(true);
    expect(input.descriptionHtml).toBe('');
    expect(input.employmentType).toBeNull();
  });

  it('location and remote helpers prefer detail fields', () => {
    const raw = posting(4, { locationsText: '13 Locations', detail: { location: 'Houston, TX', additionalLocations: ['Austin, TX', 'Houston, TX', ' '], remoteType: 'Hybrid Job' } });
    expect(workdayLocations(raw)).toEqual(['Houston, TX', 'Austin, TX']);
    expect(workdayRemoteFlag(raw)).toBe(false);
    expect(workdayRemoteFlag(posting(5, { remoteType: 'Onsite Job' }))).toBe(false);
    expect(workdayRemoteFlag(posting(6, { remoteType: 'Flexible' }))).toBeNull();
    expect(workdayRemoteFlag(posting(7))).toBeNull();
  });

  it('ignores an externalUrl off the allowed hosts and keeps the constructed url', () => {
    const raw = posting(8, { detail: { externalUrl: 'https://evil.example/apply', jobDescription: '<p>x</p>' } });
    const input = workdayAdapter.toInput(raw, board(), FIRST_SEEN);
    expect(input.applyUrl).toBe('https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Software-Intern-8_JR1008');
    const bad = posting(9, { detail: { externalUrl: 'not a url' } });
    expect(workdayAdapter.toInput(bad, board(), FIRST_SEEN).applyUrl).toMatch(/^https:\/\/nvidia\.wd5\.myworkdayjobs\.com\//);
  });

  it('passes a hostile posting through unchanged for the sanitizer and link validator', () => {
    const raw = posting(10, {
      title: '<script>alert(1)</script> Intern',
      detail: { jobDescription: '<img src=x onerror=alert(1)><p>hi</p>', externalUrl: 'javascript:alert(1)' },
    });
    const input = workdayAdapter.toInput(raw, board(), FIRST_SEEN);
    expect(input.title).toBe('<script>alert(1)</script> Intern');
    expect(input.descriptionHtml).toContain('onerror');
    // javascript: is not an allowed host, so the constructed https URL is used instead.
    expect(input.applyUrl).toMatch(/^https:\/\//);
  });

  it('returns the raw job unchanged on a 304 detail and rejects a bad detail shape', async () => {
    const raw = posting(11);
    const a = fakeFetch(() => json('', 304));
    expect(await a.adapter.fetchDetail!(board(), raw, a.http)).toBe(raw);
    const b = fakeFetch(() => json(JSON.stringify({ jobPostingInfo: { title: 5 }, leak: 'nope' })));
    await expect(b.adapter.fetchDetail!(board(), raw, b.http)).rejects.toThrow(/^workday:nvidia\/NVIDIAExternalCareerSite detail: unexpected payload shape/);
    await expect(b.adapter.fetchDetail!(board(), raw, b.http)).rejects.not.toThrow(/nope/);
  });

  it('refuses hosts outside the allowlist via the client', async () => {
    const { http, adapter } = fakeFetch(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }));
    await expect(adapter.listJobs(board(), http)).rejects.toBeInstanceOf(HttpError);
  });
});
