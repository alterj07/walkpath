import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LEVER_MAX_PAGES,
  LEVER_PAGE_SIZE,
  LeverRawJobSchema,
  leverAdapter,
  leverDescriptionHtml,
  leverPageUrl,
  leverSalaryPeriod,
  type LeverRawJob,
} from '../../src/adapters/lever.ts';
import { HttpClient, BOT_USER_AGENT, type FetchLike } from '../../src/http/client.ts';
import type { Board } from '../../src/schema/board.ts';

const FIXTURES = new URL('../fixtures/lever/', import.meta.url);

function fixture(name: string): LeverRawJob[] {
  return JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8')) as LeverRawJob[];
}

function board(key: string): Board {
  return {
    company_slug: key.replace(/^eu:/, ''),
    company_name: key,
    domain: `${key.replace(/^eu:/, '')}.com`,
    ats: 'lever',
    board_key: key,
    careers_url: `https://jobs.lever.co/${key.replace(/^eu:/, '')}`,
    added_at: '2026-10-09',
    status: 'active',
  };
}

interface Call {
  url: string;
  init: RequestInit;
}

/** Fake fetch serving `pages` keyed by `skip`; the clock makes the 1 s crawl delay free. */
function serve(handler: (url: URL, n: number) => Response) {
  const calls: Call[] = [];
  let t = 1_000_000;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(new URL(url), calls.length);
  };
  const http = new HttpClient({
    fetch: fetchImpl,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    random: () => 0.5,
    respectRobots: false,
  });
  return { calls, http };
}

function json(body: unknown, status = 200): Response {
  return new Response(status === 304 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const FIRST_SEEN = new Date('2026-10-09T12:00:00.000Z');

describe('leverAdapter policy and urls', () => {
  it('declares the Lever hosts and the 1 s crawl delay', () => {
    expect(leverAdapter.source).toBe('lever');
    expect(leverAdapter.policy.minDelayMs).toBe(1000);
    expect(leverAdapter.policy.maxConcurrencyPerHost).toBe(10);
    expect(leverAdapter.policy.allowedHosts).toEqual(['api.lever.co', 'api.eu.lever.co', 'jobs.lever.co', 'jobs.eu.lever.co']);
  });

  it('builds US and EU page urls from the board key convention', () => {
    expect(leverPageUrl('palantir', 0)).toBe('https://api.lever.co/v0/postings/palantir?mode=json&skip=0&limit=100');
    expect(leverPageUrl('eu:octoenergy', 200)).toBe('https://api.eu.lever.co/v0/postings/octoenergy?mode=json&skip=200&limit=100');
  });
});

describe('leverAdapter.listJobs', () => {
  it('returns every posting from a single short page with the bot user agent', async () => {
    const page = fixture('palantir');
    const { calls, http } = serve(() => json(page));
    const jobs = await leverAdapter.listJobs(board('palantir'), http);
    expect(jobs.map((j) => j.id)).toEqual(page.map((j) => j.id));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.lever.co/v0/postings/palantir?mode=json&skip=0&limit=100');
    expect((calls[0]!.init.headers as Record<string, string>)['user-agent']).toBe(BOT_USER_AGENT);
  });

  it('pages with skip/limit until a short page and dedupes ids that shifted between pages', async () => {
    const template = fixture('zoox')[0]!;
    const make = (n: number): LeverRawJob => ({ ...template, id: `job-${n}`, text: `Job ${n}` });
    const pages: Record<string, LeverRawJob[]> = {
      '0': Array.from({ length: LEVER_PAGE_SIZE }, (_, i) => make(i)),
      // job-99 appears again at the top of page two, as happens when a posting is added mid-crawl.
      '100': [make(99), ...Array.from({ length: LEVER_PAGE_SIZE - 1 }, (_, i) => make(100 + i))],
      '200': Array.from({ length: 12 }, (_, i) => make(200 + i)),
    };
    const { calls, http } = serve((url) => json(pages[url.searchParams.get('skip') ?? ''] ?? []));
    const jobs = await leverAdapter.listJobs(board('zoox'), http);
    expect(calls.map((c) => new URL(c.url).searchParams.get('skip'))).toEqual(['0', '100', '200']);
    expect(jobs).toHaveLength(211);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(211);
  });

  it('stops after a full page followed by an empty page', async () => {
    const template = fixture('zoox')[0]!;
    const full = Array.from({ length: LEVER_PAGE_SIZE }, (_, i) => ({ ...template, id: `j${i}` }));
    const { calls, http } = serve((url) => json(url.searchParams.get('skip') === '0' ? full : []));
    const jobs = await leverAdapter.listJobs(board('zoox'), http);
    expect(jobs).toHaveLength(100);
    expect(calls).toHaveLength(2);
  });

  it('returns an empty list for a board with no published postings', async () => {
    const { http } = serve(() => json([]));
    expect(await leverAdapter.listJobs(board('nielsen'), http)).toEqual([]);
  });

  it('uses the EU host for eu: board keys', async () => {
    const { calls, http } = serve(() => json([]));
    await leverAdapter.listJobs(board('eu:octoenergy'), http);
    expect(new URL(calls[0]!.url).hostname).toBe('api.eu.lever.co');
  });

  it('treats a 304 (data: null) as the end of the list rather than crashing', async () => {
    const { http } = serve(() => json(null, 304));
    expect(await leverAdapter.listJobs(board('palantir'), http)).toEqual([]);
  });

  it('rejects a payload that is not a list of postings with a readable, body-free error', async () => {
    const { http } = serve(() => json({ ok: false, error: 'Document not found SECRET-MARKER' }));
    const err = await leverAdapter.listJobs(board('nope'), http).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^lever:nope page 0: unexpected payload shape: /);
    expect((err as Error).message).not.toContain('SECRET-MARKER');
  });

  it('stops when a full page adds no new ids (host ignoring skip) instead of looping forever', async () => {
    const template = fixture('zoox')[0]!;
    const full = Array.from({ length: LEVER_PAGE_SIZE }, (_, i) => ({ ...template, id: `j${i}` }));
    const { calls, http } = serve(() => json(full));
    const jobs = await leverAdapter.listJobs(board('zoox'), http);
    expect(jobs).toHaveLength(100);
    expect(calls).toHaveLength(2);
  });

  it('throws after the page cap when every page is full and new', async () => {
    const template = fixture('zoox')[0]!;
    const { calls, http } = serve((url) => {
      const skip = Number(url.searchParams.get('skip'));
      return json(Array.from({ length: LEVER_PAGE_SIZE }, (_, i) => ({ ...template, id: `j${skip + i}` })));
    });
    await expect(leverAdapter.listJobs(board('zoox'), http)).rejects.toThrow(
      `lever:zoox: paging exceeded ${LEVER_MAX_PAGES} pages`,
    );
    expect(calls).toHaveLength(LEVER_MAX_PAGES);
  });

  it('rejects a posting missing required fields and names the field', async () => {
    const broken = [{ text: 'No id or applyUrl', createdAt: 1 }];
    const { http } = serve(() => json(broken));
    await expect(leverAdapter.listJobs(board('palantir'), http)).rejects.toThrow(/id/);
  });
});

describe('leverAdapter mapping', () => {
  const palantir = fixture('palantir');
  const octo = fixture('octoenergy');
  const zoox = fixture('zoox');
  const intern = palantir.find((j) => j.id === 'a49d4181-a289-435a-b581-7f5af0497c8e')!;

  it('maps a US internship: title, location, commitment, onsite flag, urls, posted time', () => {
    const input = leverAdapter.toInput(intern, board('palantir'), FIRST_SEEN);
    expect(input.externalId).toBe(intern.id);
    expect(input.internalReqId).toBeNull();
    expect(input.title).toBe('Deployment Strategist, Internship - US Government');
    expect(input.locations).toEqual(['Honolulu, HI']);
    expect(input.employmentType).toBe('Internship');
    expect(input.remoteFlag).toBe(false);
    expect(input.applyUrl).toBe(intern.applyUrl);
    expect(input.hostedUrl).toBe(intern.hostedUrl);
    expect(input.postedAt).toBe(new Date(intern.createdAt!).toISOString());
    expect(input.postedAtSource).toBe('ATS_FIELD');
    expect(input.department).toBe('Echo');
    expect(input.salary).toBeNull();
    expect(input.applicationDeadline).toBeNull();
  });

  it('parsePostedAt reads createdAt as epoch milliseconds and returns null when missing', () => {
    expect(leverAdapter.parsePostedAt(intern, FIRST_SEEN)?.toISOString()).toBe('2025-12-11T22:31:15.446Z');
    expect(leverAdapter.parsePostedAt({ ...intern, createdAt: null }, FIRST_SEEN)).toBeNull();
    expect(leverAdapter.parsePostedAt({ ...intern, createdAt: 0 }, FIRST_SEEN)).toBeNull();
  });

  it('falls back to first_seen when createdAt is absent', () => {
    const input = leverAdapter.toInput({ ...intern, createdAt: undefined }, board('palantir'), FIRST_SEEN);
    expect(input.postedAt).toBe(FIRST_SEEN.toISOString());
    expect(input.postedAtSource).toBe('FIRST_SEEN');
  });

  it('builds the canonical key from the board key and posting id', () => {
    expect(leverAdapter.canonicalKey(intern, board('palantir'))).toBe(`lever:palantir:${intern.id}`);
    expect(leverAdapter.canonicalKey(intern, board('eu:palantir'))).toBe(`lever:eu:palantir:${intern.id}`);
  });

  it('concatenates opening, description, each list under an h3, and additional', () => {
    const html = leverDescriptionHtml(intern);
    expect(html.startsWith(intern.opening!)).toBe(true);
    expect(html).toContain(intern.description!);
    for (const list of intern.lists!) {
      expect(html).toContain(`<h3>${list.text}</h3>${list.content}`);
    }
    expect(html.endsWith(intern.additional!)).toBe(true);
    const noOpening = palantir.find((j) => j.id === '774cf5c9-bf6a-4d77-bf60-d50ef1beb1a0')!;
    expect(leverDescriptionHtml(noOpening).startsWith(noOpening.description!)).toBe(true);
  });

  it('maps workplaceType to remoteFlag: remote true, onsite/hybrid false, unspecified null', () => {
    const unspecified = octo.find((j) => j.workplaceType === 'unspecified')!;
    expect(leverAdapter.toInput(unspecified, board('octoenergy'), FIRST_SEEN).remoteFlag).toBeNull();
    const hybrid = octo.find((j) => j.workplaceType === 'hybrid')!;
    expect(leverAdapter.toInput(hybrid, board('octoenergy'), FIRST_SEEN).remoteFlag).toBe(false);
    expect(leverAdapter.toInput({ ...hybrid, workplaceType: 'remote' }, board('octoenergy'), FIRST_SEEN).remoteFlag).toBe(true);
  });

  it('maps salaryRange intervals to periods and keeps the currency', () => {
    const monthly = octo.find((j) => j.id === '44523d13-3285-45a7-97cf-c6e1f3b743a3')!;
    expect(leverAdapter.toInput(monthly, board('octoenergy'), FIRST_SEEN).salary).toEqual({
      min: 2800,
      max: 7000,
      currency: 'EUR',
      period: 'month',
    });
    const hourly = zoox.find((j) => j.id === '0c03e57f-fe89-4a65-857e-af7ec6eadadf')!;
    expect(leverAdapter.toInput(hourly, board('zoox'), FIRST_SEEN).salary).toEqual({ min: 52, max: 64, currency: 'USD', period: 'hour' });
    const yearly = zoox.find((j) => j.id === 'e8a190f0-7a89-4c11-a6a0-452ff6234749')!;
    expect(leverAdapter.toInput(yearly, board('zoox'), FIRST_SEEN).salary).toEqual({
      min: 123000,
      max: 168000,
      currency: 'USD',
      period: 'year',
    });
    expect(leverSalaryPeriod('per-week-wage')).toBe('week');
    expect(leverSalaryPeriod('something-else')).toBeNull();
    expect(leverSalaryPeriod(null)).toBeNull();
  });

  it('prefers allLocations and falls back to location; drops empty strings', () => {
    const multi = { ...intern, categories: { ...intern.categories, allLocations: ['New York, NY', ' ', 'Denver, CO'] } };
    expect(leverAdapter.toInput(multi, board('palantir'), FIRST_SEEN).locations).toEqual(['New York, NY', 'Denver, CO']);
    const single = { ...intern, categories: { ...intern.categories, allLocations: [] } };
    expect(leverAdapter.toInput(single, board('palantir'), FIRST_SEEN).locations).toEqual(['Honolulu, HI']);
    const none = { ...intern, categories: { commitment: 'Internship' } };
    expect(leverAdapter.toInput(none, board('palantir'), FIRST_SEEN).locations).toEqual([]);
  });

  it('uses department over team and tolerates a null country', () => {
    const zx = zoox.find((j) => j.id === '5e03b357-0cc1-4194-9488-14f85044f4f9')!;
    expect(leverAdapter.toInput(zx, board('zoox'), FIRST_SEEN).department).toBe('Zoox Internships');
    const nullCountry = octo.find((j) => j.country === null || j.country === undefined)!;
    expect(nullCountry).toBeDefined();
    expect(() => leverAdapter.toInput(nullCountry, board('octoenergy'), FIRST_SEEN)).not.toThrow();
  });

  it('parses every recorded fixture posting without throwing', () => {
    for (const [key, jobs] of [
      ['palantir', palantir],
      ['octoenergy', octo],
      ['zoox', zoox],
    ] as const) {
      for (const raw of jobs) {
        LeverRawJobSchema.parse(raw);
        const input = leverAdapter.toInput(raw, board(key), FIRST_SEEN);
        expect(input.title.length).toBeGreaterThan(0);
        expect(input.descriptionHtml.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('leverAdapter malicious fixtures', () => {
  it('passes a script-bearing title and a javascript: apply url through unchanged', async () => {
    const template = fixture('zoox')[0]!;
    const evil: LeverRawJob = {
      ...template,
      id: 'evil-1',
      text: '<script>alert(1)</script> Software Intern',
      applyUrl: 'javascript:alert(1)',
      hostedUrl: 'javascript:alert(2)',
      description: '<img src=x onerror=alert(1)>',
    };
    const { http } = serve(() => json([evil]));
    const [raw] = await leverAdapter.listJobs(board('zoox'), http);
    const input = leverAdapter.toInput(raw!, board('zoox'), FIRST_SEEN);
    expect(input.title).toBe('<script>alert(1)</script> Software Intern');
    expect(input.applyUrl).toBe('javascript:alert(1)');
    expect(input.hostedUrl).toBe('javascript:alert(2)');
    expect(input.descriptionHtml).toContain('<img src=x onerror=alert(1)>');
  });

  it('does not accept an oversized page silently: the client caps the body', async () => {
    const template = fixture('zoox')[0]!;
    const huge = Array.from({ length: 40 }, (_, i) => ({ ...template, id: `big-${i}`, description: 'x'.repeat(200_000) }));
    const body = JSON.stringify(huge);
    let t = 0;
    const http = new HttpClient({
      fetch: async () => new Response(body, { status: 200, headers: { 'content-length': String(body.length) } }),
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      respectRobots: false,
    });
    await expect(leverAdapter.listJobs(board('zoox'), http)).rejects.toMatchObject({ code: 'body_too_large' });
  });
});
