import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HttpClient, HttpError, type FetchLike } from '../../src/http/client.ts';
import type { Board } from '../../src/schema/board.ts';
import { JobPostingInputSchema } from '../../src/schema/job.ts';
import {
  WorkableAccountSchema,
  isWorkableBoardNotFound,
  parseWorkableDate,
  listWorkableJobs,
  workableAdapter,
  workableListUrl,
  workableLocations,
} from '../../src/adapters/workable.ts';

const FIXTURES = new URL('../fixtures/workable/', import.meta.url);
function fixture(name: string): string {
  return readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8');
}

function board(key: string): Board {
  return {
    company_slug: key,
    company_name: key,
    domain: `${key}.example.com`,
    ats: 'workable',
    board_key: key,
    careers_url: `https://apply.workable.com/${key}/`,
    added_at: '2026-10-09',
    status: 'active',
  };
}

function res(body: string | null, status = 200, headers: Record<string, string> = {}) {
  return new Response(status === 304 ? null : body, { status, headers });
}

/** Fake fetch serving fixtures by account subdomain; records calls. */
function makeClient(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  let t = 1_000_000;
  const http = new HttpClient({
    fetch: fetchImpl,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    random: () => 0.5,
    respectRobots: false,
  });
  return { http, calls };
}

function serveFixtures() {
  return makeClient((url) => {
    const m = /accounts\/([^/?]+)\?details=true$/.exec(url);
    if (!m) return res('Not Found', 404);
    try {
      return res(fixture(m[1]!), 200, { 'content-type': 'application/json; charset=utf-8' });
    } catch {
      return res('Not Found', 404, { 'content-type': 'text/plain; charset=utf-8' });
    }
  });
}

const FIRST_SEEN = new Date('2026-10-09T15:00:00Z');

describe('workable adapter: URL and policy', () => {
  it('calls the apply.workable.com widget endpoint with details=true', () => {
    expect(workableListUrl('twgai')).toBe('https://apply.workable.com/api/v1/widget/accounts/twgai?details=true');
  });

  it('rejects board keys that are not bare subdomains', () => {
    expect(() => workableListUrl('../etc')).toThrow(/invalid board_key/);
    expect(() => workableListUrl('a b')).toThrow(/invalid board_key/);
    expect(() => workableListUrl('')).toThrow(/invalid board_key/);
  });

  it('declares the Workable hosts and polite limits', () => {
    expect(workableAdapter.source).toBe('workable');
    expect(workableAdapter.policy.minDelayMs).toBe(500);
    expect(workableAdapter.policy.maxConcurrencyPerHost).toBe(5);
    expect(workableAdapter.policy.allowedHosts).toEqual(['*.workable.com']);
  });
});

describe('workable adapter: live fixtures', () => {
  for (const key of ['tmeic-corporation-americas', 'enfos-inc', 'twgai']) {
    it(`lists and maps every job on ${key}`, async () => {
      const { http, calls } = serveFixtures();
      const raws = await workableAdapter.listJobs(board(key), http);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(workableListUrl(key));
      expect(raws.length).toBeGreaterThan(0);
      for (const raw of raws) {
        const input = workableAdapter.toInput(raw, board(key), FIRST_SEEN);
        const parsed = JobPostingInputSchema.safeParse(input);
        expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
        expect(input.externalId).toBe(raw.shortcode);
        expect(input.applyUrl).toMatch(/^https:\/\/apply\.workable\.com\/j\/[A-Z0-9]+\/apply$/);
        expect(input.hostedUrl).toMatch(/^https:\/\/apply\.workable\.com\/j\/[A-Z0-9]+$/);
        expect(input.postedAtSource).toBe('ATS_FIELD');
        expect(input.locations.length).toBeGreaterThan(0);
        expect(workableAdapter.canonicalKey(raw, board(key))).toBe(`workable:${key}:${raw.shortcode}`);
      }
    });
  }

  it('maps the TMEIC intern posting field by field', async () => {
    const { http } = serveFixtures();
    const raws = await workableAdapter.listJobs(board('tmeic-corporation-americas'), http);
    const raw = raws.find((r) => r.code === 'ET26076')!;
    const input = workableAdapter.toInput(raw, board('tmeic-corporation-americas'), FIRST_SEEN);
    expect(input.title).toBe('Intern - Engineer (Spring 2027) EIS (ET26076)');
    expect(input.internalReqId).toBe('ET26076');
    expect(input.employmentType).toBe('Temporary');
    expect(input.remoteFlag).toBe(false);
    expect(input.locations).toEqual(['Houston, Texas, United States']);
    expect(input.department).toBe('TMEIC Corporation Americas');
    expect(input.postedAt).toBe('2026-08-12T00:00:00.000Z');
    expect(input.descriptionHtml.startsWith('<')).toBe(true);
    expect(input.salary).toBeNull();
    expect(input.applicationDeadline).toBeNull();
  });

  it('turns empty-string code/employment_type/department into null', async () => {
    const { http } = serveFixtures();
    const raws = await workableAdapter.listJobs(board('enfos-inc'), http);
    const marketing = raws.find((r) => r.title === 'Senior Director of Marketing')!;
    const input = workableAdapter.toInput(marketing, board('enfos-inc'), FIRST_SEEN);
    expect(input.internalReqId).toBeNull();
    expect(input.employmentType).toBeNull();
    expect(input.department).toBeNull();
  });

  it('marks telecommuting jobs remote', async () => {
    const { http } = serveFixtures();
    const raws = await workableAdapter.listJobs(board('twgai'), http);
    const uk = raws.find((r) => r.title === 'AI Data Science Intern (UK)')!;
    expect(workableAdapter.toInput(uk, board('twgai'), FIRST_SEEN).remoteFlag).toBe(true);
  });

  it('published_on wins over created_at for posted_at', async () => {
    const { http } = serveFixtures();
    const raws = await workableAdapter.listJobs(board('twgai'), http);
    const raw = raws[0]!;
    expect(raw.published_on).toBe('2026-09-01');
    expect(raw.created_at).toBe('2026-08-13');
    expect(workableAdapter.parsePostedAt(raw, FIRST_SEEN)?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('workable adapter: dates', () => {
  it('parses date-only as midnight UTC and full datetimes as-is', () => {
    expect(parseWorkableDate('2026-09-01')?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(parseWorkableDate('2026-09-01T12:34:56.000-04:00')?.toISOString()).toBe('2026-09-01T16:34:56.000Z');
  });

  it('returns null for empty or garbage values', () => {
    expect(parseWorkableDate('')).toBeNull();
    expect(parseWorkableDate(null)).toBeNull();
    expect(parseWorkableDate(undefined)).toBeNull();
    expect(parseWorkableDate('yesterday')).toBeNull();
  });

  it('falls back to created_at, then FIRST_SEEN', () => {
    const base = {
      title: 'Intern',
      shortcode: 'ABC123',
      application_url: 'https://apply.workable.com/j/ABC123/apply',
      url: 'https://apply.workable.com/j/ABC123',
    };
    const viaCreated = workableAdapter.toInput(
      { ...base, published_on: '', created_at: '2026-05-05' },
      board('x'),
      FIRST_SEEN,
    );
    expect(viaCreated.postedAt).toBe('2026-05-05T00:00:00.000Z');
    expect(viaCreated.postedAtSource).toBe('ATS_FIELD');
    const viaSeen = workableAdapter.toInput({ ...base, published_on: null, created_at: null }, board('x'), FIRST_SEEN);
    expect(viaSeen.postedAt).toBe(FIRST_SEEN.toISOString());
    expect(viaSeen.postedAtSource).toBe('FIRST_SEEN');
  });
});

describe('workable adapter: locations', () => {
  it('labels each locations[] entry and dedupes', () => {
    expect(
      workableLocations({
        title: 't',
        shortcode: 's',
        locations: [
          { city: 'Austin', region: 'Texas', country: 'United States' },
          { city: 'Austin', region: 'Texas', country: 'United States' },
          { city: '', region: '', country: 'Canada' },
        ],
      }),
    ).toEqual(['Austin, Texas, United States', 'Canada']);
  });

  it('falls back to the top-level city/state/country when locations[] is empty', () => {
    expect(
      workableLocations({ title: 't', shortcode: 's', locations: [], city: 'Chicago', state: 'Illinois', country: 'United States' }),
    ).toEqual(['Chicago, Illinois, United States']);
    expect(workableLocations({ title: 't', shortcode: 's', locations: null })).toEqual([]);
  });

  it('remoteFlag is null when the payload says nothing about remote work', () => {
    const input = workableAdapter.toInput(
      { title: 't', shortcode: 's', application_url: 'https://apply.workable.com/j/S/apply' },
      board('x'),
      FIRST_SEEN,
    );
    expect(input.remoteFlag).toBeNull();
  });

  it('appends requirements and benefits sections when a payload carries them', () => {
    const input = workableAdapter.toInput(
      {
        title: 't',
        shortcode: 's',
        application_url: 'https://apply.workable.com/j/S/apply',
        description: '<p>Desc</p>',
        requirements: '<ul><li>Python</li></ul>',
        benefits: '<p>Snacks</p>',
      },
      board('x'),
      FIRST_SEEN,
    );
    expect(input.descriptionHtml).toBe('<p>Desc</p><h3>Requirements</h3><ul><li>Python</li></ul><h3>Benefits</h3><p>Snacks</p>');
  });
});

describe('workable adapter: malicious and malformed payloads', () => {
  const malicious = JSON.stringify({
    name: 'Evil Co',
    description: '',
    jobs: [
      {
        title: 'Intern <script>alert(1)</script>',
        shortcode: 'EVIL01',
        code: '',
        employment_type: 'Temporary',
        telecommuting: false,
        department: null,
        url: 'https://apply.workable.com/j/EVIL01',
        shortlink: 'https://apply.workable.com/j/EVIL01',
        application_url: 'javascript:alert(1)',
        published_on: '2026-10-01',
        created_at: '2026-10-01',
        country: 'United States',
        city: 'Austin',
        state: 'Texas',
        locations: [{ country: 'United States', countryCode: 'US', city: 'Austin', region: 'Texas', hidden: false }],
        description: '<p>Hi</p><img src=x onerror=alert(1)>',
      },
    ],
  });

  it('maps a hostile job unchanged; sanitizer and link validator run downstream', async () => {
    const { http } = makeClient(() => res(malicious));
    const raws = await workableAdapter.listJobs(board('evil'), http);
    expect(raws).toHaveLength(1);
    const input = workableAdapter.toInput(raws[0]!, board('evil'), FIRST_SEEN);
    expect(input.title).toBe('Intern <script>alert(1)</script>');
    expect(input.applyUrl).toBe('javascript:alert(1)');
    expect(input.descriptionHtml).toContain('onerror');
    expect(JobPostingInputSchema.safeParse(input).success).toBe(true);
  });

  it('fails with a readable error when required fields are missing', async () => {
    const { http } = makeClient(() => res(JSON.stringify({ name: 'x', jobs: [{ title: 'No shortcode' }] })));
    await expect(workableAdapter.listJobs(board('broken'), http)).rejects.toThrow(/workable:broken: unexpected payload shape: .*shortcode/);
  });

  it('fails when jobs is not an array', async () => {
    const { http } = makeClient(() => res(JSON.stringify({ name: 'x', jobs: 'nope' })));
    await expect(workableAdapter.listJobs(board('broken'), http)).rejects.toThrow(/jobs/);
  });

  it('tolerates unknown keys at every level', () => {
    const parsed = WorkableAccountSchema.safeParse({
      name: 'x',
      extra: 1,
      jobs: [{ title: 't', shortcode: 's', future_key: { a: 1 }, locations: [{ city: 'A', zip: '1' }] }],
    });
    expect(parsed.success).toBe(true);
  });

  it('drops jobs that have no application_url, url or shortlink, counting them without naming them', async () => {
    const account = JSON.parse(fixture('twgai')) as { jobs: Record<string, unknown>[] };
    const orphan = { ...account.jobs[0]!, shortcode: 'ORPHAN1', title: 'Orphan SECRET-TITLE', application_url: '', url: null, shortlink: '' };
    const { http } = makeClient(() => res(JSON.stringify({ ...account, jobs: [...account.jobs, orphan] })));
    const lines: string[] = [];
    const raws = await listWorkableJobs(board('twgai'), http, (l) => lines.push(l));
    expect(raws.map((r) => r.shortcode)).not.toContain('ORPHAN1');
    expect(raws).toHaveLength(account.jobs.length);
    expect(lines).toEqual(['workable:twgai: dropped 1 job(s) without an apply url']);
    expect(lines.join('\n')).not.toContain('SECRET-TITLE');
  });

  it('returns an empty list on 304 (data: null) instead of crashing', async () => {
    const { http } = makeClient(() => res(null, 304));
    const raws = await workableAdapter.listJobs(board('twgai'), http);
    expect(raws).toEqual([]);
  });
});

describe('workable adapter: not-a-customer signals', () => {
  it('404 from the widget endpoint is board-not-found', async () => {
    const { http } = makeClient(() => res('Not Found', 404, { 'content-type': 'text/plain' }));
    const err = await workableAdapter.listJobs(board('zzz-no-such-account'), http).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(isWorkableBoardNotFound(err)).toBe(true);
  });

  it('a 302 to a host outside the Workable allowlist is refused and reads as board-not-found', async () => {
    const { http, calls } = makeClient((url) =>
      url.includes('apply.workable.com')
        ? res('', 302, { location: 'https://evil.example.com/landing' })
        : res('never', 200),
    );
    const err = await workableAdapter.listJobs(board('redirected'), http).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('redirect_not_allowed');
    expect(isWorkableBoardNotFound(err)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('a 302 that stays on Workable hosts is followed', async () => {
    const { http, calls } = makeClient((url) =>
      url.startsWith('https://apply.workable.com/api/v1/widget/accounts/moved')
        ? res('', 302, { location: 'https://www.workable.com/api/accounts/moved?details=true' })
        : res(fixture('twgai'), 200),
    );
    const raws = await workableAdapter.listJobs(board('moved'), http);
    expect(raws.length).toBeGreaterThan(0);
    expect(calls.map((c) => c.url)).toEqual([
      'https://apply.workable.com/api/v1/widget/accounts/moved?details=true',
      'https://www.workable.com/api/accounts/moved?details=true',
    ]);
  });

  it('other errors are not board-not-found', async () => {
    const { http } = makeClient(() => res('boom', 503));
    const err = await workableAdapter.listJobs(board('flaky'), http).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(isWorkableBoardNotFound(err)).toBe(false);
    expect(isWorkableBoardNotFound(new Error('x'))).toBe(false);
  });
});
