import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HttpClient, HttpError, type FetchLike } from '../../src/http/client.ts';
import { JobPostingInputSchema } from '../../src/schema/job.ts';
import type { Board } from '../../src/schema/board.ts';
import {
  ORACLE_MAX_PAGES,
  ORACLE_PAGE_SIZE,
  ORACLE_POLICY,
  createOracleAdapter,
  oracleAdapter,
  oracleDescriptionHtml,
  oracleDetailUrl,
  oracleHostedUrl,
  oracleListUrl,
  oracleLocations,
  oracleRemoteFlag,
  parseOracleDate,
  type OracleRawJob,
} from '../../src/adapters/oracle.ts';

const FIXTURES = new URL('../fixtures/oracle/', import.meta.url);
const fixture = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');

function board(key = 'eeho.fa.us2.oraclecloud.com/CX_45001'): Board {
  return {
    company_slug: 'oracle',
    company_name: 'Oracle',
    domain: 'oracle.com',
    ats: 'oracle',
    board_key: key,
    careers_url: 'https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_45001',
    added_at: '2026-10-10',
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
  const adapter = createOracleAdapter({
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

function req(n: number, extra: Partial<OracleRawJob> = {}): OracleRawJob {
  return {
    Id: String(100 + n),
    Title: `Software Engineer Intern ${n}`,
    PostedDate: '2026-10-09',
    PrimaryLocation: 'Austin, TX, United States',
    PrimaryLocationCountry: 'US',
    WorkplaceType: 'Hybrid',
    secondaryLocations: [],
    ...extra,
  };
}

function page(list: OracleRawJob[], total: number): string {
  return JSON.stringify({ items: [{ TotalJobsCount: total, requisitionList: list }] });
}

function offsetOf(url: string): number {
  const m = /offset=(\d+)/.exec(url);
  return m ? Number(m[1]) : -1;
}

const FIRST_SEEN = new Date('2026-10-10T12:00:00.000Z');

describe('oracle adapter: policy and urls', () => {
  it('policy matches the plan: 1 concurrent, 1 s apart, oraclecloud hosts only', () => {
    expect(ORACLE_POLICY).toEqual({ minDelayMs: 1_000, maxConcurrencyPerHost: 1, allowedHosts: ['*.oraclecloud.com', '*.ocs.oraclecloud.com'] });
    expect(oracleAdapter.source).toBe('oracle');
  });

  it('builds the list, detail and hosted urls from host/site', () => {
    expect(oracleListUrl(board(), 25)).toBe(
      'https://eeho.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations,flexFieldsFacet.values&finder=findReqs;siteNumber=CX_45001,limit=25,offset=25,sortBy=POSTING_DATES_DESC',
    );
    expect(oracleDetailUrl(board(), '347172')).toBe(
      'https://eeho.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=347172,siteNumber=CX_45001',
    );
    expect(oracleHostedUrl(board(), '347172')).toBe('https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_45001/job/347172');
  });

  it('rejects malformed board keys', () => {
    expect(() => oracleListUrl(board('oraclecloud.com'), 0)).toThrow(/host\/siteNumber/);
    expect(() => oracleListUrl(board('evil.example.com/CX_1'), 0)).toThrow(/host\/siteNumber/);
    expect(() => oracleListUrl(board('eeho.fa.us2.oraclecloud.com/CX 1'), 0)).toThrow(/host\/siteNumber/);
    expect(() => oracleListUrl(board('eeho.fa.us2.oraclecloud.com/CX_1/extra'), 0)).toThrow(/host\/siteNumber/);
  });
});

describe('oracle adapter: listJobs', () => {
  it('pages by 25 until TotalJobsCount and dedupes across pages', async () => {
    const all = Array.from({ length: 52 }, (_, i) => req(i));
    const { adapter, http, calls } = fakeFetch((url) => {
      const off = offsetOf(url);
      // The third page repeats one id shifted from page two (mid-crawl insert).
      const slice = off === 50 ? [all[49]!, all[50]!, all[51]!] : all.slice(off, off + ORACLE_PAGE_SIZE);
      return json(page(slice, 52));
    });
    const jobs = await adapter.listJobs(board(), http);
    expect(calls.map((c) => offsetOf(c.url))).toEqual([0, 25, 50]);
    expect(jobs.map((j) => j.Id)).toEqual(all.map((j) => j.Id));
    expect(calls[0]!.init.method ?? 'GET').toBe('GET');
  });

  it('stops on a short page', async () => {
    const { adapter, http, calls } = fakeFetch(() => json(page([req(1), req(2)], 2)));
    const jobs = await adapter.listJobs(board(), http);
    expect(jobs).toHaveLength(2);
    expect(calls).toHaveLength(1);
  });

  it('empty page before total: retries once after 5 s, then fails the fetch (never closures)', async () => {
    const { adapter, http, slept, calls } = fakeFetch(() => json(page([], 40)));
    await expect(adapter.listJobs(board(), http)).rejects.toThrow('oracle:eeho.fa.us2.oraclecloud.com/CX_45001: empty page before total');
    expect(slept).toEqual([5_000]);
    expect(calls).toHaveLength(2);
  });

  it('recovers when the retried page comes back', async () => {
    const { adapter, http } = fakeFetch((_url, n) => (n === 1 ? json(page([], 1)) : json(page([req(1)], 1))));
    const jobs = await adapter.listJobs(board(), http);
    expect(jobs.map((j) => j.Id)).toEqual(['101']);
  });

  it('re-fetches the current page once when the total grows mid-crawl', async () => {
    const { adapter, http, calls } = fakeFetch((_url, n) => {
      if (n === 1) return json(page(Array.from({ length: 25 }, (_, i) => req(i)), 26));
      if (n === 2) return json(page([req(25)], 27)); // total grew → re-fetch offset 25
      return json(page([req(25), req(26)], 27));
    });
    const jobs = await adapter.listJobs(board(), http);
    expect(calls.map((c) => offsetOf(c.url))).toEqual([0, 25, 25]);
    expect(jobs).toHaveLength(27);
  });

  it('empty board (total 0) is not a throttle', async () => {
    const { adapter, http, slept } = fakeFetch(() => json(page([], 0)));
    expect(await adapter.listJobs(board(), http)).toEqual([]);
    expect(slept).toEqual([]);
  });

  it('gives up after the page cap', async () => {
    const { adapter, http } = fakeFetch((url) => json(page(Array.from({ length: 25 }, (_, i) => req(offsetOf(url) + i)), 1_000_000)));
    await expect(adapter.listJobs(board(), http)).rejects.toThrow(`paging exceeded ${ORACLE_MAX_PAGES} pages`);
  });

  it('304 ends the list', async () => {
    const { adapter, http } = fakeFetch(() => json('', 304));
    expect(await adapter.listJobs(board(), http)).toEqual([]);
  });

  it('malformed payload fails with a body-free message', async () => {
    const { adapter, http } = fakeFetch(() => json(JSON.stringify({ items: [{ TotalJobsCount: 1, requisitionList: [{ Title: 'x' }] }] })));
    await expect(adapter.listJobs(board(), http)).rejects.toThrow(/oracle:eeho\.fa\.us2\.oraclecloud\.com\/CX_45001 list offset 0: unexpected payload shape/);
  });

  it('403 surfaces as a forbidden HttpError without the body', async () => {
    const { adapter, http } = fakeFetch(() => new Response('<html>blocked</html>', { status: 403, headers: { 'content-type': 'text/html' } }));
    const err = await adapter.listJobs(board(), http).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('forbidden');
    expect((err as HttpError).message).not.toContain('blocked');
  });

  it('refuses redirects off the allowed hosts', async () => {
    const { adapter, http } = fakeFetch(() => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x' } }));
    const err = await adapter.listJobs(board(), http).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('redirect_not_allowed');
  });

  it('every recorded list fixture parses', async () => {
    for (const name of ['oracle', 'fanatics', 'egug']) {
      const { adapter, http } = fakeFetch(() => json(fixture(`${name}-list.json`)));
      const jobs = await adapter.listJobs(board(), http);
      expect(jobs.length).toBeGreaterThan(0);
      for (const j of jobs) expect(() => JobPostingInputSchema.parse(adapter.toInput(j, board(), FIRST_SEEN))).not.toThrow();
    }
  });
});

describe('oracle adapter: detail and mapping', () => {
  it('merges the detail response and maps a recorded posting', async () => {
    const { adapter, http } = fakeFetch(() => json(fixture('oracle-347172-detail.json')));
    const light = (JSON.parse(fixture('oracle-list.json')) as { items: Array<{ requisitionList: OracleRawJob[] }> }).items[0]!.requisitionList[0]!;
    const full = await adapter.fetchDetail!(board(), light, http);
    const input = adapter.toInput(full, board(), FIRST_SEEN);
    expect(input.externalId).toBe('347172');
    expect(input.title).toBe('Senior Core Infrastructure Engineer');
    expect(input.descriptionHtml).toContain('Oracle Cloud Infrastructure');
    expect(input.descriptionHtml).toContain('<h3>Responsibilities</h3>');
    expect(input.descriptionHtml).toContain('<h3>Qualifications</h3>');
    expect(input.locations[0]).toBe('Seattle, WA, United States');
    expect(input.locations).toContain('Santa Clara, CA, United States');
    expect(input.postedAt).toBe('2026-10-10T00:03:07.000Z');
    expect(input.postedAtSource).toBe('ATS_FIELD');
    expect(input.applyUrl).toBe('https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_45001/job/347172');
    expect(input.hostedUrl).toBe(input.applyUrl);
    expect(adapter.canonicalKey(full, board())).toBe('oracle:eeho.fa.us2.oraclecloud.com/CX_45001:347172');
  });

  it('light posting maps from the list fields alone', () => {
    const input = oracleAdapter.toInput(req(1, { ExternalQualificationsStr: '<p>BS in CS</p>', WorkerType: 'Intern', JobFamily: 'Engineering' }), board(), FIRST_SEEN);
    expect(input.descriptionHtml).toBe('<h3>Qualifications</h3><p>BS in CS</p>');
    expect(input.postedAt).toBe('2026-10-09T00:00:00.000Z');
    expect(input.postedAtSource).toBe('ATS_FIELD');
    expect(input.employmentType).toBe('Intern');
    expect(input.department).toBe('Engineering');
    expect(input.remoteFlag).toBe(false);
  });

  it('falls back to first_seen when no date is present', () => {
    const input = oracleAdapter.toInput(req(1, { PostedDate: null }), board(), FIRST_SEEN);
    expect(input.postedAt).toBe(FIRST_SEEN.toISOString());
    expect(input.postedAtSource).toBe('FIRST_SEEN');
    expect(oracleAdapter.parsePostedAt(req(1, { PostedDate: 'yesterday' }), FIRST_SEEN)).toBeNull();
  });

  it('parses dates and workplace types', () => {
    expect(parseOracleDate('2026-10-09')).toBe('2026-10-09T00:00:00.000Z');
    expect(parseOracleDate('2026-09-23T08:07:34+00:00')).toBe('2026-09-23T08:07:34.000Z');
    expect(parseOracleDate('')).toBeNull();
    expect(parseOracleDate('10/09/2026')).toBeNull();
    expect(oracleRemoteFlag(req(1, { WorkplaceType: 'Remote' }))).toBe(true);
    expect(oracleRemoteFlag(req(1, { WorkplaceType: 'On-site' }))).toBe(false);
    expect(oracleRemoteFlag(req(1, { WorkplaceType: '' }))).toBeNull();
  });

  it('dedupes locations and prefers the detail', () => {
    const raw = req(1, {
      secondaryLocations: [{ Name: 'Austin, TX, United States', CountryCode: 'US' }, { Name: 'Denver, CO, United States', CountryCode: 'US' }],
      detail: { PrimaryLocation: 'Remote, United States', secondaryLocations: [{ Name: 'Boston, MA, United States' }] },
    });
    expect(oracleLocations(raw)).toEqual(['Remote, United States', 'Boston, MA, United States']);
    expect(oracleLocations(req(1, { secondaryLocations: [{ Name: 'Austin, TX, United States' }] }))).toEqual(['Austin, TX, United States']);
  });

  it('uses ApplyUrl only when it is https on an allowed host', () => {
    const ok = oracleAdapter.toInput(req(1, { detail: { ApplyUrl: 'https://fa-x.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/101/apply' } }), board(), FIRST_SEEN);
    expect(ok.applyUrl).toBe('https://fa-x.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/101/apply');
    const off = oracleAdapter.toInput(req(1, { detail: { ApplyUrl: 'https://evil.example.com/apply' } }), board(), FIRST_SEEN);
    expect(off.applyUrl).toBe(oracleHostedUrl(board(), '101'));
    const bad = oracleAdapter.toInput(req(1, { detail: { ApplyUrl: 'javascript:alert(1)' } }), board(), FIRST_SEEN);
    expect(bad.applyUrl).toBe(oracleHostedUrl(board(), '101'));
  });

  it('short description is the last resort', () => {
    expect(oracleDescriptionHtml(req(1, { ShortDescriptionStr: 'Build things' }))).toBe('<p>Build things</p>');
    expect(oracleDescriptionHtml(req(1))).toBe('');
  });

  it('hostile posting passes through unchanged for the sanitizer and link validator', () => {
    const raw = req(1, { Title: '<script>alert(1)</script> Intern', detail: { ExternalDescriptionStr: '<img src=x onerror=alert(1)>', ApplyUrl: 'javascript:alert(1)' } });
    const input = oracleAdapter.toInput(raw, board(), FIRST_SEEN);
    expect(input.title).toBe('<script>alert(1)</script> Intern');
    expect(input.descriptionHtml).toContain('onerror');
    expect(input.applyUrl).toBe(oracleHostedUrl(board(), '101'));
  });

  it('detail 304 keeps the raw posting; a bad detail shape is rejected', async () => {
    const r = req(1);
    const notModified = fakeFetch(() => json('', 304));
    expect(await notModified.adapter.fetchDetail!(board(), r, notModified.http)).toBe(r);
    const bad = fakeFetch(() => json(JSON.stringify({ items: [{ Title: 5 }] })));
    await expect(bad.adapter.fetchDetail!(board(), r, bad.http)).rejects.toThrow(/detail: unexpected payload shape/);
    const empty = fakeFetch(() => json(JSON.stringify({ items: [] })));
    expect(await empty.adapter.fetchDetail!(board(), r, empty.http)).toBe(r);
  });
});
