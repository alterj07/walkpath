import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GREENHOUSE_POLICY,
  GreenhouseRawJobSchema,
  decodeEntitiesOnce,
  fetchGreenhouseList,
  greenhouseAdapter,
  parseGreenhouseLocation,
  parseGreenhouseSalary,
} from '../../src/adapters/greenhouse.ts';
import { HttpClient, type FetchLike } from '../../src/http/client.ts';
import { BoardSchema, type Board } from '../../src/schema/board.ts';
import { JobPostingInputSchema } from '../../src/schema/job.ts';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'greenhouse');
const fixture = (name: string) => readFileSync(join(fixtures, name), 'utf8');

const FIRST_SEEN = new Date('2026-10-09T15:17:00.000Z');

function board(key: string): Board {
  return BoardSchema.parse({
    company_slug: key,
    company_name: key,
    domain: `${key}.com`,
    ats: 'greenhouse',
    board_key: key,
    wd: '',
    careers_url: `https://boards.greenhouse.io/${key}`,
    added_at: '2026-10-09',
    status: 'active',
  });
}

interface Route {
  status?: number;
  body: string;
  headers?: Record<string, string>;
}

/** Fake fetch keyed by exact URL; records every call. */
function fakeHttp(routes: Record<string, Route>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404 });
    const status = route.status ?? 200;
    return new Response(status === 304 ? null : route.body, { status, headers: route.headers ?? {} });
  };
  const http = new HttpClient({ fetch: fetchImpl, respectRobots: false, sleep: async () => undefined });
  return { http, calls };
}

const LIST = (key: string) => `https://boards-api.greenhouse.io/v1/boards/${key}/jobs?pay_transparency=true`;
const DETAIL = (key: string, id: number) =>
  `https://boards-api.greenhouse.io/v1/boards/${key}/jobs/${id}?questions=false&pay_transparency=true`;

describe('greenhouse adapter: policy and keys', () => {
  it('declares the Greenhouse hosts and concurrency from the plan', () => {
    expect(greenhouseAdapter.source).toBe('greenhouse');
    expect(GREENHOUSE_POLICY.maxConcurrencyPerHost).toBe(20);
    expect(GREENHOUSE_POLICY.allowedHosts).toContain('boards-api.greenhouse.io');
    expect(GREENHOUSE_POLICY.allowedHosts).toContain('job-boards.greenhouse.io');
  });

  it('builds the canonical key from the board token and the numeric id', () => {
    const raw = GreenhouseRawJobSchema.parse({ id: 6178851004, title: 't', absolute_url: 'https://x' });
    expect(greenhouseAdapter.canonicalKey(raw, board('figma'))).toBe('greenhouse:figma:6178851004');
  });
});

describe('greenhouse adapter: listJobs (light list)', () => {
  it('requests the light list with pay transparency and maps every job', async () => {
    const { http, calls } = fakeHttp({ [LIST('figma')]: { body: fixture('figma-list.json') } });
    const jobs = await greenhouseAdapter.listJobs(board('figma'), http);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(LIST('figma'));
    expect(calls[0]!.url).not.toContain('content=true');
    expect(jobs).toHaveLength(5);
    const intern = jobs.find((j) => j.title === 'Data Engineer Intern (2027)')!;
    expect(intern.id).toBe(6178851004);
    expect(intern.content).toBeUndefined();
  });

  it('url-encodes the board token', async () => {
    const { http, calls } = fakeHttp({});
    await greenhouseAdapter.listJobs(board('a-b'), http).catch(() => undefined);
    expect(calls[0]!.url).toContain('/v1/boards/a-b/jobs');
  });

  it('maps a Figma intern posting: bullet-separated offices, hourly pay, employer timestamp', async () => {
    const { http } = fakeHttp({ [LIST('figma')]: { body: fixture('figma-list.json') } });
    const jobs = await greenhouseAdapter.listJobs(board('figma'), http);
    const raw = jobs.find((j) => j.title === 'Data Engineer Intern (2027)')!;
    const input = greenhouseAdapter.toInput(raw, board('figma'), FIRST_SEEN);
    expect(JobPostingInputSchema.safeParse(input).success).toBe(true);
    expect(input).toMatchObject({
      externalId: '6178851004',
      internalReqId: '5209995004',
      title: 'Data Engineer Intern (2027)',
      descriptionHtml: '',
      locations: ['San Francisco, CA', 'New York, NY'],
      applyUrl: 'https://boards.greenhouse.io/figma/jobs/6178851004?gh_jid=6178851004',
      hostedUrl: 'https://boards.greenhouse.io/figma/jobs/6178851004?gh_jid=6178851004',
      postedAt: '2026-09-23T19:30:27.000Z',
      postedAtSource: 'ATS_FIELD',
      salary: { min: 46, max: 46, currency: 'USD', period: 'hour' },
      department: null,
      applicationDeadline: null,
    });
    expect(input.remoteFlag).toBeNull();
  });

  it('maps a Duolingo intern posting: deadline, Req Type metadata, explicit hourly range', async () => {
    const { http } = fakeHttp({ [LIST('duolingo')]: { body: fixture('duolingo-list.json') } });
    const jobs = await greenhouseAdapter.listJobs(board('duolingo'), http);
    const raw = jobs.find((j) => j.title === 'Illustrator, Intern')!;
    const input = greenhouseAdapter.toInput(raw, board('duolingo'), FIRST_SEEN);
    expect(input.applicationDeadline).toBe('2026-11-06T05:00:00.000Z');
    expect(input.employmentType).toBe('University - Graduating Intern');
    expect(input.salary).toEqual({ min: 39, max: 41, currency: 'USD', period: 'hour' });
    expect(input.locations).toEqual(['Detroit, MI']);
    expect(input.applyUrl).toMatch(/^https:\/\/careers\.duolingo\.com\/jobs\/8863967002/);
  });

  it('tolerates boolean and object metadata values (yes_no, currency) without failing the board', async () => {
    const { http } = fakeHttp({ [LIST('duolingo')]: { body: fixture('duolingo-list.json') } });
    const jobs = await greenhouseAdapter.listJobs(board('duolingo'), http);
    const raw = jobs.find((j) => j.id === 8863967002)!;
    const names = (raw.metadata ?? []).map((m) => m.name);
    expect(names).toContain('Visa Sponsorship');
    expect(names).toContain('Signing Bonus');
    const input = greenhouseAdapter.toInput(raw, board('duolingo'), FIRST_SEEN);
    // The string-valued Req Type still wins; the object and boolean entries are ignored, not errors.
    expect(input.employmentType).toBe('University - Graduating Intern');
  });

  it('maps Anthropic rows: mixed ; and | separators are split and de-duplicated, Location Type drives remoteFlag, annual pay', async () => {
    const { http } = fakeHttp({ [LIST('anthropic')]: { body: fixture('anthropic-list.json') } });
    const jobs = await greenhouseAdapter.listJobs(board('anthropic'), http);
    const multi = jobs.find((j) => /[;|]/.test(j.location?.name ?? ''))!;
    const input = greenhouseAdapter.toInput(multi, board('anthropic'), FIRST_SEEN);
    expect(input.locations.length).toBeGreaterThan(1);
    expect(new Set(input.locations).size).toBe(input.locations.length);
    expect(input.remoteFlag).toBe(false);
    expect(input.salary?.period).toBe('year');
    expect(input.salary?.min).toBeGreaterThan(100_000);
  });

  it('maps Stripe rows: empty pay ranges become null and a comma-only office label stays whole', async () => {
    const { http } = fakeHttp({ [LIST('stripe')]: { body: fixture('stripe-list.json') } });
    const jobs = await greenhouseAdapter.listJobs(board('stripe'), http);
    const raw = jobs.find((j) => j.location?.name === 'New York, Seattle, South San Francisco HQ')!;
    const input = greenhouseAdapter.toInput(raw, board('stripe'), FIRST_SEEN);
    expect(input.salary).toBeNull();
    expect(input.locations).toEqual(['New York, Seattle, South San Francisco HQ']);
    expect(input.employmentType).toBeNull();
    expect(input.applyUrl).toBe('https://stripe.com/jobs/search?gh_jid=' + raw.id);
  });

  it('every fixture job maps to a valid JobPostingInput', async () => {
    for (const key of ['figma', 'stripe', 'anthropic', 'databricks', 'duolingo']) {
      const { http } = fakeHttp({ [LIST(key)]: { body: fixture(`${key}-list.json`) } });
      const jobs = await greenhouseAdapter.listJobs(board(key), http);
      expect(jobs.length).toBeGreaterThan(0);
      for (const raw of jobs) {
        const input = greenhouseAdapter.toInput(raw, board(key), FIRST_SEEN);
        const parsed = JobPostingInputSchema.safeParse(input);
        expect(parsed.success, `${key} ${raw.id}: ${parsed.error?.message ?? ''}`).toBe(true);
      }
    }
  });
});

describe('greenhouse adapter: fetchDetail', () => {
  it('fetches the single job, decodes the escaped HTML once and keeps list identity', async () => {
    const { http, calls } = fakeHttp({
      [LIST('figma')]: { body: fixture('figma-list.json') },
      [DETAIL('figma', 6178851004)]: { body: fixture('figma-6178851004-detail.json') },
    });
    const jobs = await greenhouseAdapter.listJobs(board('figma'), http);
    const light = jobs.find((j) => j.id === 6178851004)!;
    const full = await greenhouseAdapter.fetchDetail!(board('figma'), light, http);
    expect(calls[1]!.url).toBe(DETAIL('figma', 6178851004));
    expect(full.id).toBe(6178851004);
    expect(full.content).toMatch(/^&lt;div class=&quot;content-intro&quot;&gt;/);
    const input = greenhouseAdapter.toInput(full, board('figma'), FIRST_SEEN);
    expect(input.descriptionHtml.startsWith('<div class="content-intro"><p>Figma is growing')).toBe(true);
    expect(input.descriptionHtml).not.toContain('&lt;');
    expect(input.department).toBe('Early Career');
    expect(JobPostingInputSchema.safeParse(input).success).toBe(true);
  });

  it('Duolingo detail: department University, hourly internship range survives the merge', async () => {
    const { http } = fakeHttp({ [DETAIL('duolingo', 8863967002)]: { body: fixture('duolingo-8863967002-detail.json') } });
    const light = GreenhouseRawJobSchema.parse({ id: 8863967002, title: 'x', absolute_url: 'https://x' });
    const full = await greenhouseAdapter.fetchDetail!(board('duolingo'), light, http);
    const input = greenhouseAdapter.toInput(full, board('duolingo'), FIRST_SEEN);
    expect(input.title).toBe('Illustrator, Intern');
    expect(input.department).toBe('University');
    expect(input.salary?.period).toBe('hour');
    expect(input.descriptionHtml).toMatch(/^<p>Our mission at Duolingo/);
  });
});

describe('greenhouse adapter: timestamps (plan 3.2)', () => {
  const base = { id: 1, title: 'Software Intern', absolute_url: 'https://boards.greenhouse.io/x/jobs/1' };

  it('prefers first_published, then updated_at', () => {
    const both = GreenhouseRawJobSchema.parse({ ...base, first_published: '2026-10-01T10:00:00-04:00', updated_at: '2026-10-05T10:00:00-04:00' });
    expect(greenhouseAdapter.parsePostedAt(both, FIRST_SEEN)?.toISOString()).toBe('2026-10-01T14:00:00.000Z');
    const updatedOnly = GreenhouseRawJobSchema.parse({ ...base, first_published: null, updated_at: '2026-10-05T10:00:00-04:00' });
    expect(greenhouseAdapter.parsePostedAt(updatedOnly, FIRST_SEEN)?.toISOString()).toBe('2026-10-05T14:00:00.000Z');
  });

  it('falls back to first_seen_at with FIRST_SEEN when the ATS gives nothing usable', () => {
    const none = GreenhouseRawJobSchema.parse({ ...base, first_published: 'garbage', updated_at: null });
    expect(greenhouseAdapter.parsePostedAt(none, FIRST_SEEN)).toBeNull();
    const input = greenhouseAdapter.toInput(none, board('x'), FIRST_SEEN);
    expect(input.postedAt).toBe(FIRST_SEEN.toISOString());
    expect(input.postedAtSource).toBe('FIRST_SEEN');
  });
});

describe('greenhouse adapter: helpers', () => {
  it('splits offices on ; | • and " & " but not on commas', () => {
    expect(parseGreenhouseLocation('San Francisco, CA; Chicago, IL & New York, NY')).toEqual(['San Francisco, CA', 'Chicago, IL', 'New York, NY']);
    expect(parseGreenhouseLocation('A | B • C')).toEqual(['A', 'B', 'C']);
    expect(parseGreenhouseLocation('  Remote - US  ')).toEqual(['Remote - US']);
    expect(parseGreenhouseLocation(null)).toEqual([]);
    expect(parseGreenhouseLocation('X; X')).toEqual(['X']);
  });

  it('decodes entities exactly once', () => {
    expect(decodeEntitiesOnce('&lt;p&gt;a &amp;amp; b&#39;s &#x27;q&#x27; &amp;nbsp;&lt;/p&gt;')).toBe("<p>a &amp; b's 'q' &nbsp;</p>");
    expect(decodeEntitiesOnce('&#99999999;')).toBe('&#99999999;');
  });

  it('collapses zone pay ranges and infers the period', () => {
    const raw = GreenhouseRawJobSchema.parse({
      id: 1,
      title: 't',
      absolute_url: 'https://x',
      pay_input_ranges: [
        { min_cents: 100_000_00, max_cents: 120_000_00, currency_type: 'usd', title: 'Zone 1' },
        { min_cents: 90_000_00, max_cents: 140_000_00, currency_type: 'usd', title: 'Zone 2' },
      ],
    });
    expect(parseGreenhouseSalary(raw)).toEqual({ min: 90000, max: 140000, currency: 'USD', period: 'year' });
    const ambiguous = GreenhouseRawJobSchema.parse({ ...raw, pay_input_ranges: [{ min_cents: 1_000_00, max_cents: 5_000_00, currency_type: 'USD', title: 'Stipend' }] });
    expect(parseGreenhouseSalary(ambiguous)).toEqual({ min: 1000, max: 5000, currency: 'USD', period: null });
    const hourly = GreenhouseRawJobSchema.parse({ ...raw, pay_input_ranges: [{ min_cents: 2500, max_cents: 3000, currency_type: null, title: null }] });
    expect(parseGreenhouseSalary(hourly)).toEqual({ min: 25, max: 30, currency: 'USD', period: 'hour' });
  });

  it('remoteFlag from title/location text when no Location Type metadata', () => {
    const raw = GreenhouseRawJobSchema.parse({ id: 1, title: 'SWE Intern (Remote)', absolute_url: 'https://x', location: { name: 'US' } });
    expect(greenhouseAdapter.toInput(raw, board('x'), FIRST_SEEN).remoteFlag).toBe(true);
  });
});

describe('greenhouse adapter: hostile and broken payloads', () => {
  it('passes a script title and a javascript: apply URL through untouched (sanitizer and validator run downstream)', async () => {
    const hostile = {
      jobs: [
        {
          id: 42,
          internal_job_id: 7,
          title: 'Intern <script>alert(1)</script>',
          absolute_url: 'javascript:alert(1)',
          location: { name: 'Remote' },
          first_published: '2026-10-01T00:00:00Z',
          updated_at: null,
          metadata: null,
          pay_input_ranges: [],
          content: '&lt;img src=x onerror=alert(1)&gt;',
        },
      ],
      meta: { total: 1 },
    };
    const { http } = fakeHttp({ [LIST('evil')]: { body: JSON.stringify(hostile) } });
    const jobs = await greenhouseAdapter.listJobs(board('evil'), http);
    const input = greenhouseAdapter.toInput(jobs[0]!, board('evil'), FIRST_SEEN);
    expect(input.title).toBe('Intern <script>alert(1)</script>');
    expect(input.applyUrl).toBe('javascript:alert(1)');
    expect(input.descriptionHtml).toBe('<img src=x onerror=alert(1)>');
    expect(JobPostingInputSchema.safeParse(input).success).toBe(true);
  });

  it('rejects a list whose job lacks required fields with a readable, body-free error', async () => {
    const broken = { jobs: [{ title: 'No id SECRET-MARKER', absolute_url: 'https://x' }] };
    const { http } = fakeHttp({ [LIST('broken')]: { body: JSON.stringify(broken) } });
    const err = await greenhouseAdapter.listJobs(board('broken'), http).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/greenhouse:broken list: unexpected payload shape: jobs\.0\.id/);
    expect((err as Error).message).not.toContain('SECRET-MARKER');
  });

  it('rejects a non-object payload', async () => {
    const { http } = fakeHttp({ [LIST('weird')]: { body: '[]' } });
    await expect(greenhouseAdapter.listJobs(board('weird'), http)).rejects.toThrow(/unexpected payload shape/);
  });

  it('propagates http errors (404 board) as HttpError, never as a closure', async () => {
    const { http } = fakeHttp({});
    await expect(greenhouseAdapter.listJobs(board('gone'), http)).rejects.toMatchObject({ code: 'http_status', status: 404 });
  });

  it('returns notModified with null jobs on 304 and sends the validators', async () => {
    const { http, calls } = fakeHttp({ [LIST('figma')]: { status: 304, body: '', headers: { etag: 'W/"abc"' } } });
    const result = await fetchGreenhouseList(board('figma'), http, { etag: 'W/"abc"' });
    expect(result).toEqual({ jobs: null, notModified: true, etag: 'W/"abc"', lastModified: null });
    expect((calls[0]!.init.headers as Record<string, string>)['if-none-match']).toBe('W/"abc"');
  });

  it('fetchGreenhouseList returns the ETag from a full response for the next conditional GET', async () => {
    const { http } = fakeHttp({ [LIST('figma')]: { body: fixture('figma-list.json'), headers: { etag: 'W/"v2"' } } });
    const result = await fetchGreenhouseList(board('figma'), http);
    expect(result.notModified).toBe(false);
    expect(result.etag).toBe('W/"v2"');
    expect(result.jobs).toHaveLength(5);
  });
});
