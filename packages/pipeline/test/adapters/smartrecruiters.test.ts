import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HttpClient, type FetchLike } from '../../src/http/client.ts';
import type { Board } from '../../src/schema/board.ts';
import {
  SMARTRECRUITERS_MISSING_KEY_MESSAGE,
  SMARTRECRUITERS_PAGE_SIZE,
  SmartRecruitersListSchema,
  createSmartRecruitersAdapter,
  descriptionFromDetail,
  smartrecruitersAdapter,
  type SmartRecruitersRawJob,
} from '../../src/adapters/smartrecruiters.ts';

const FIXTURES = new URL('../fixtures/smartrecruiters/', import.meta.url);

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), 'utf8');
}

function board(key: string): Board {
  return {
    company_slug: key.toLowerCase(),
    company_name: key,
    domain: 'example.com',
    ats: 'smartrecruiters',
    board_key: key,
    careers_url: `https://jobs.smartrecruiters.com/${key}`,
    added_at: '2026-10-09',
    status: 'active',
  };
}

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(handler: (url: string, n: number) => Response) {
  const calls: Call[] = [];
  let t = 1_000_000;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(url, calls.length);
  };
  const http = new HttpClient({
    fetch: fetchImpl,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    random: () => 0.5,
  });
  return { calls, http };
}

function json(body: string, status = 200): Response {
  return new Response(status === 304 ? null : body, { status, headers: { 'content-type': 'application/json' } });
}

const FIRST_SEEN = new Date('2026-10-09T15:00:00.000Z');
const adapter = createSmartRecruitersAdapter({ apiKey: 'test-token' });

describe('smartrecruiters listJobs', () => {
  it('lists the recorded Bosch board, sending the token and bypassing robots', async () => {
    const f = fakeFetch(() => json(fixture('list-BoschGroup.json')));
    const jobs = await adapter.listJobs(board('BoschGroup'), f.http);
    expect(jobs).toHaveLength(5);
    expect(jobs[0]!.name).toBe('Internship Printed Circuit Boards Material Characterization');
    // Exactly one request: the page is short, so no second page is fetched.
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(
      `https://api.smartrecruiters.com/v1/companies/BoschGroup/postings?limit=${SMARTRECRUITERS_PAGE_SIZE}&offset=0`,
    );
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-smarttoken']).toBe('test-token');
    // No robots.txt round trip happened (respectRobots: false).
    expect(f.calls.some((c) => c.url.endsWith('/robots.txt'))).toBe(false);
  });

  it('pages by offset until totalFound is reached', async () => {
    const base = SmartRecruitersListSchema.parse(JSON.parse(fixture('list-LLNL.json')));
    const make = (n: number, idStart: number): SmartRecruitersRawJob[] =>
      Array.from({ length: n }, (_, i) => ({ ...base.content[0]!, id: String(idStart + i), name: `Job ${idStart + i}` }));
    const total = SMARTRECRUITERS_PAGE_SIZE * 2 + 7;
    const pages = [make(SMARTRECRUITERS_PAGE_SIZE, 0), make(SMARTRECRUITERS_PAGE_SIZE, 100), make(7, 200)];
    const f = fakeFetch((url) => {
      const offset = Number(new URL(url).searchParams.get('offset'));
      const page = pages[offset / SMARTRECRUITERS_PAGE_SIZE]!;
      return json(JSON.stringify({ offset, limit: SMARTRECRUITERS_PAGE_SIZE, totalFound: total, content: page }));
    });
    const jobs = await adapter.listJobs(board('LLNL'), f.http);
    expect(jobs).toHaveLength(total);
    expect(f.calls.map((c) => new URL(c.url).searchParams.get('offset'))).toEqual(['0', '100', '200']);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(total);
  });

  it('dedupes a posting that shifted onto two pages when one was added mid-crawl', async () => {
    const base = SmartRecruitersListSchema.parse(JSON.parse(fixture('list-LLNL.json')));
    const make = (ids: number[]): SmartRecruitersRawJob[] => ids.map((id) => ({ ...base.content[0]!, id: String(id) }));
    const pageOne = make(Array.from({ length: SMARTRECRUITERS_PAGE_SIZE }, (_, i) => i));
    // Posting 99 is pushed down to the top of page two by an insert at the front.
    const pageTwo = make([99, ...Array.from({ length: 4 }, (_, i) => 100 + i)]);
    const f = fakeFetch((url) => {
      const offset = Number(new URL(url).searchParams.get('offset'));
      const content = offset === 0 ? pageOne : pageTwo;
      return json(JSON.stringify({ offset, limit: SMARTRECRUITERS_PAGE_SIZE, totalFound: 105, content }));
    });
    const jobs = await adapter.listJobs(board('LLNL'), f.http);
    expect(jobs).toHaveLength(104);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(104);
  });

  it('stops after a page when offset reaches totalFound even if the page was full', async () => {
    const base = SmartRecruitersListSchema.parse(JSON.parse(fixture('list-WesternDigital.json')));
    const full = Array.from({ length: SMARTRECRUITERS_PAGE_SIZE }, (_, i) => ({ ...base.content[0]!, id: String(i) }));
    const f = fakeFetch(() => json(JSON.stringify({ offset: 0, limit: 100, totalFound: 100, content: full })));
    const jobs = await adapter.listJobs(board('WesternDigital'), f.http);
    expect(jobs).toHaveLength(100);
    expect(f.calls).toHaveLength(1);
  });

  it('throws a clear error without an api key and makes no request', async () => {
    const f = fakeFetch(() => json(fixture('list-BoschGroup.json')));
    const noKey = createSmartRecruitersAdapter({ apiKey: () => undefined });
    await expect(noKey.listJobs(board('BoschGroup'), f.http)).rejects.toThrow(SMARTRECRUITERS_MISSING_KEY_MESSAGE);
    const blankKey = createSmartRecruitersAdapter({ apiKey: '  ' });
    await expect(blankKey.listJobs(board('BoschGroup'), f.http)).rejects.toThrow(SMARTRECRUITERS_MISSING_KEY_MESSAGE);
    expect(f.calls).toHaveLength(0);
  });

  it('the default export reads the key lazily from the environment', async () => {
    const f = fakeFetch(() => json(fixture('list-BoschGroup.json')));
    const previous = process.env['SMARTRECRUITERS_API_KEY'];
    try {
      delete process.env['SMARTRECRUITERS_API_KEY'];
      await expect(smartrecruitersAdapter.listJobs(board('BoschGroup'), f.http)).rejects.toThrow(
        SMARTRECRUITERS_MISSING_KEY_MESSAGE,
      );
      process.env['SMARTRECRUITERS_API_KEY'] = 'env-token';
      const jobs = await smartrecruitersAdapter.listJobs(board('BoschGroup'), f.http);
      expect(jobs).toHaveLength(5);
      expect((f.calls[0]!.init.headers as Record<string, string>)['x-smarttoken']).toBe('env-token');
    } finally {
      if (previous === undefined) delete process.env['SMARTRECRUITERS_API_KEY'];
      else process.env['SMARTRECRUITERS_API_KEY'] = previous;
    }
  });

  it('returns no jobs on 304 (data null)', async () => {
    const f = fakeFetch(() => json('', 304));
    const jobs = await adapter.listJobs(board('BoschGroup'), f.http);
    expect(jobs).toEqual([]);
  });

  it('fails parsing with a readable, body-free error when required fields are missing', async () => {
    const f = fakeFetch(() => json(JSON.stringify({ offset: 0, limit: 100, totalFound: 1, content: [{ name: 'No id SECRET-MARKER' }] })));
    const err = await adapter.listJobs(board('BoschGroup'), f.http).catch((e: unknown) => e as Error);
    expect((err as Error).message).toMatch(/^smartrecruiters:BoschGroup offset 0: unexpected payload shape: content\.0\.id/);
    expect((err as Error).message).not.toContain('SECRET-MARKER');
  });

  it('refuses hosts outside the allowlist', async () => {
    const f = fakeFetch(() => json(fixture('list-BoschGroup.json')));
    await expect(
      f.http.getJson({ url: 'https://evil.example/x', allowedHosts: adapter.policy.allowedHosts, limits: { minDelayMs: 0, maxConcurrency: 1 } }),
    ).rejects.toMatchObject({ code: 'host_not_allowed' });
  });
});

describe('smartrecruiters fetchDetail and toInput', () => {
  it('merges the detail sections, apply and posting urls into the input', async () => {
    const f = fakeFetch((url) => {
      if (url.includes('/postings/744000154435119')) return json(fixture('detail-744000154435119.json'));
      return json(fixture('list-BoschGroup.json'));
    });
    const b = board('BoschGroup');
    const list = SmartRecruitersListSchema.parse(JSON.parse(fixture('list-BoschGroup.json')));
    const light = { ...list.content[0]!, id: '744000154435119', name: 'IT Intern - Cybersecurity & AI (f/m)' };
    const withDetail = await adapter.fetchDetail!(b, light, f.http);
    expect(f.calls[0]!.url).toBe('https://api.smartrecruiters.com/v1/companies/BoschGroup/postings/744000154435119');
    expect((f.calls[0]!.init.headers as Record<string, string>)['x-smarttoken']).toBe('test-token');
    const input = adapter.toInput(withDetail, b, FIRST_SEEN);
    expect(input.applyUrl).toBe(
      'https://jobs.smartrecruiters.com/BoschGroup/744000154435119-it-intern-cybersecurity-ai-f-m-?oga=true',
    );
    expect(input.hostedUrl).toBe('https://jobs.smartrecruiters.com/BoschGroup/744000154435119-it-intern-cybersecurity-ai-f-m-');
    expect(input.descriptionHtml.startsWith('<h3>Company Description</h3>')).toBe(true);
    expect(input.descriptionHtml).toContain('<h3>Job Description</h3>');
    expect(input.descriptionHtml).toContain('<h3>Qualifications</h3>');
    expect(input.descriptionHtml).toContain('<h3>Additional Information</h3>');
    expect(input.descriptionHtml.indexOf('<h3>Job Description</h3>')).toBeLessThan(input.descriptionHtml.indexOf('<h3>Qualifications</h3>'));
    expect(input.postedAtSource).toBe('ATS_FIELD');
  });

  it('maps a recorded US intern posting (light, no detail) with a constructed hosted url', () => {
    const b = board('WesternDigital');
    const list = SmartRecruitersListSchema.parse(JSON.parse(fixture('list-WesternDigital.json')));
    const raw = list.content.find((j) => j.id === '744000152261929')!;
    const input = adapter.toInput(raw, b, FIRST_SEEN);
    expect(input).toMatchObject({
      externalId: '744000152261929',
      title: 'Winter 2027 Intern/Co-op Development Engineer',
      locations: ['Rochester, MN, United States'],
      employmentType: 'Intern',
      remoteFlag: false,
      applyUrl: 'https://jobs.smartrecruiters.com/WesternDigital/744000152261929',
      hostedUrl: 'https://jobs.smartrecruiters.com/WesternDigital/744000152261929',
      postedAtSource: 'ATS_FIELD',
      descriptionHtml: '',
      salary: null,
    });
    expect(input.internalReqId).toBe(raw.refNumber);
    expect(input.postedAt).toBe(new Date(raw.releasedDate!).toISOString());
    // department is `{}` in live data: label absent → null, not a crash.
    expect(input.department).toBeNull();
    expect(adapter.canonicalKey(raw, b)).toBe('smartrecruiters:WesternDigital:744000152261929');
  });

  it('falls back to city/region/country and first_seen when fullLocation and releasedDate are missing', () => {
    const b = board('LLNL');
    const list = SmartRecruitersListSchema.parse(JSON.parse(fixture('list-LLNL.json')));
    const raw: SmartRecruitersRawJob = {
      ...list.content[0]!,
      releasedDate: null,
      location: { city: 'Livermore', region: 'CA', country: 'us', remote: true },
    };
    expect(adapter.parsePostedAt(raw, FIRST_SEEN)).toBeNull();
    const input = adapter.toInput(raw, b, FIRST_SEEN);
    expect(input.locations).toEqual(['Livermore, CA, us']);
    expect(input.remoteFlag).toBe(true);
    expect(input.postedAt).toBe(FIRST_SEEN.toISOString());
    expect(input.postedAtSource).toBe('FIRST_SEEN');
  });

  it('treats an unparseable releasedDate as absent', () => {
    const list = SmartRecruitersListSchema.parse(JSON.parse(fixture('list-LLNL.json')));
    const raw = { ...list.content[0]!, releasedDate: 'yesterday' };
    expect(adapter.parsePostedAt(raw, FIRST_SEEN)).toBeNull();
  });

  it('keeps every recorded fixture parseable and mappable', () => {
    for (const name of ['list-BoschGroup.json', 'list-WesternDigital.json', 'list-LLNL.json']) {
      const list = SmartRecruitersListSchema.parse(JSON.parse(fixture(name)));
      expect(list.content.length).toBeGreaterThan(0);
      for (const raw of list.content) {
        const input = adapter.toInput(raw, board('X'), FIRST_SEEN);
        expect(input.title.length).toBeGreaterThan(0);
        expect(input.applyUrl.startsWith('https://jobs.smartrecruiters.com/X/')).toBe(true);
      }
    }
  });

  it('skips empty sections and untitled sections keep their text', () => {
    expect(descriptionFromDetail(undefined)).toBe('');
    expect(
      descriptionFromDetail({
        id: '1',
        jobAd: {
          sections: {
            companyDescription: { title: 'Company', text: '' },
            jobDescription: { title: null, text: '<p>Do things</p>' },
            qualifications: { title: 'Qualifications', text: '<ul><li>C++</li></ul>' },
          },
        },
      }),
    ).toBe('<p>Do things</p>\n<h3>Qualifications</h3><ul><li>C++</li></ul>');
  });
});

describe('smartrecruiters malicious fixtures', () => {
  it('passes a script-bearing name and a javascript: applyUrl through unchanged for downstream controls', () => {
    const list = SmartRecruitersListSchema.parse(JSON.parse(fixture('list-BoschGroup.json')));
    const raw: SmartRecruitersRawJob = {
      ...list.content[0]!,
      name: 'Intern <script>alert(1)</script>',
      detail: { id: list.content[0]!.id, applyUrl: 'javascript:alert(1)', postingUrl: null, jobAd: null },
    };
    const input = adapter.toInput(raw, board('BoschGroup'), FIRST_SEEN);
    expect(input.title).toBe('Intern <script>alert(1)</script>');
    expect(input.applyUrl).toBe('javascript:alert(1)');
    expect(input.descriptionHtml).toBe('');
  });

  it('does not forward a detail payload with a bad shape', async () => {
    const f = fakeFetch(() => json(JSON.stringify({ applyUrl: 42 })));
    const list = SmartRecruitersListSchema.parse(JSON.parse(fixture('list-BoschGroup.json')));
    await expect(adapter.fetchDetail!(board('BoschGroup'), list.content[0]!, f.http)).rejects.toThrow(
      /^smartrecruiters:BoschGroup posting: unexpected payload shape: /,
    );
  });

  it('returns the raw job unchanged when the detail request is a 304', async () => {
    const f = fakeFetch(() => json('', 304));
    const list = SmartRecruitersListSchema.parse(JSON.parse(fixture('list-BoschGroup.json')));
    const raw = list.content[0]!;
    await expect(adapter.fetchDetail!(board('BoschGroup'), raw, f.http)).resolves.toBe(raw);
  });
});
