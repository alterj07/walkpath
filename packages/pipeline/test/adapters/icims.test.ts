import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HttpClient, HttpError, type FetchLike } from '../../src/http/client.ts';
import { JobPostingInputSchema } from '../../src/schema/job.ts';
import type { Board } from '../../src/schema/board.ts';
import {
  ICIMS_MAX_PAGES,
  ICIMS_POLICY,
  decodeEntities,
  icimsAdapter,
  icimsDetailUrl,
  icimsHost,
  icimsJobUrl,
  icimsListUrl,
  isIcimsSearchPage,
  parseIcimsCard,
  parseIcimsDate,
  parseIcimsJsonLd,
  parseIcimsSalary,
  type IcimsRawJob,
} from '../../src/adapters/icims.ts';

const FIXTURES = new URL('../fixtures/icims/', import.meta.url);
const fixture = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');

function board(key = 'careers-gdms', careers = `https://${key}.icims.com/jobs/search?ss=1`): Board {
  return {
    company_slug: 'general-dynamics-mission-systems',
    company_name: 'General Dynamics Mission Systems',
    domain: '',
    ats: 'icims',
    board_key: key,
    careers_url: careers,
    added_at: '2026-10-10',
    status: 'active',
  };
}

function fakeFetch(handler: (url: string, n: number) => Response) {
  const calls: string[] = [];
  let t = 1_000_000;
  const fetchImpl: FetchLike = async (url) => {
    if (url.endsWith('/robots.txt')) return new Response('not found', { status: 404 });
    calls.push(url);
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

const html = (body: string, status = 200): Response => new Response(status === 304 ? null : body, { status, headers: { 'content-type': 'text/html;charset=UTF-8' } });

/** A synthetic search page with `n` cards whose ids start at `from`. */
function page(from: number, n: number, host = 'careers-gdms.icims.com'): string {
  const cards = Array.from({ length: n }, (_, i) => {
    const id = from + i;
    return `<li class="iCIMS_JobCardItem"><div class="row">
<div class="col-xs-6 header right"><span class="sr-only field-label">Posted Date</span><span title="10/${1 + (i % 9)}/2026 2:00 PM">3 days ago</span></div>
<div class="col-xs-12 title"><a href="https://${host}/jobs/${id}/software-intern/job" class="iCIMS_Anchor" title="${id} - Software Intern ${id}"><h3>Software Intern ${id}</h3></a></div>
<div class="col-xs-12 description">Enrolled students only.</div>
<dl class="iCIMS_JobHeaderGroup"><div class="iCIMS_JobHeaderTag"><dt class="iCIMS_JobHeaderField">ID</dt><dd class="iCIMS_JobHeaderData"><span>2026-${id}</span></dd></div>
<div class="iCIMS_JobHeaderTag"><dt class="iCIMS_JobHeaderField"><span class="sr-only field-label">Job Location</span></dt><dd class="iCIMS_JobHeaderData"><span>US-AZ-Scottsdale</span></dd></div></dl>
</div></li>`;
  }).join('\n');
  return `<html><body><ul class="container-fluid iCIMS_JobsTable">${cards}</ul></body></html>`;
}

const FIRST_SEEN = new Date('2026-10-10T15:31:07.000Z');

describe('icims adapter: policy and urls', () => {
  it('declares the polite policy', () => {
    expect(ICIMS_POLICY).toEqual({ minDelayMs: 2_000, maxConcurrencyPerHost: 1, allowedHosts: ['*.icims.com'] });
    expect(icimsAdapter.source).toBe('icims');
  });

  it('builds the host from the board key, or from an icims.com careers url', () => {
    expect(icimsHost(board())).toBe('careers-gdms.icims.com');
    expect(icimsHost(board('gdms', 'https://careers-gdms.icims.com/jobs/search'))).toBe('careers-gdms.icims.com');
    expect(icimsHost(board('careers-gdms', 'https://www.gdmissionsystems.com/careers'))).toBe('careers-gdms.icims.com');
    expect(icimsListUrl(board(), 2)).toBe('https://careers-gdms.icims.com/jobs/search?pr=2&mobile=true&needsRedirect=false');
    expect(icimsJobUrl(board(), '72997')).toBe('https://careers-gdms.icims.com/jobs/72997/job');
    expect(icimsDetailUrl(board(), '72997')).toBe('https://careers-gdms.icims.com/jobs/72997/job?in_iframe=1');
  });

  it('rejects a board key that is not a portal label', () => {
    expect(() => icimsHost(board('careers gdms'))).toThrow(/portal label/);
    expect(() => icimsHost(board('../x'))).toThrow(/portal label/);
  });
});

describe('icims adapter: parsing helpers', () => {
  it('parses the posted-date tooltip as UTC and rejects junk', () => {
    expect(parseIcimsDate('10/9/2026 2:00 PM')).toBe('2026-10-09T14:00:00.000Z');
    expect(parseIcimsDate('10/9/2026 12:05 AM')).toBe('2026-10-09T00:05:00.000Z');
    expect(parseIcimsDate('1/2/2026')).toBe('2026-01-02T00:00:00.000Z');
    expect(parseIcimsDate('yesterday')).toBeNull();
    expect(parseIcimsDate('13/40/2026 1:00 PM')).toBeNull();
    expect(parseIcimsDate(null)).toBeNull();
  });

  it('parses salary ranges from the card field', () => {
    expect(parseIcimsSalary('USD $124,397.00 - USD $138,003.00 /Yr.')).toEqual({ min: 124397, max: 138003, currency: 'USD', period: 'year' });
    expect(parseIcimsSalary('$25.00 /Hr.')).toEqual({ min: 25, max: 25, currency: 'USD', period: 'hour' });
    expect(parseIcimsSalary('Competitive')).toBeNull();
  });

  it('decodes entities and recognises search pages', () => {
    expect(decodeEntities('A &amp; B &#x7c; C &#40;x&#41; &nbsp;')).toBe('A & B | C (x)  ');
    expect(isIcimsSearchPage(fixture('gdms-search-p0.html'))).toBe(true);
    expect(isIcimsSearchPage('<html><body><form id="login">Sign in</form></body></html>')).toBe(false);
  });

  it('parses every card of the recorded fixtures with id, title, posted date and location', () => {
    const cases: Array<[string, string, number]> = [
      ['gdms-search-p0.html', 'careers-gdms.icims.com', 3],
      ['gdms-search-p1.html', 'careers-gdms.icims.com', 3],
      ['sig-search.html', 'careers-sig.icims.com', 2],
      ['peraton-search.html', 'careers-peraton.icims.com', 2],
    ];
    for (const [file, host, n] of cases) {
      const h = fixture(file);
      const starts = [...h.matchAll(/<li\b[^>]*class="[^"]*iCIMS_JobCardItem/g)].map((m) => m.index ?? 0);
      expect(starts.length, file).toBe(n);
      for (let i = 0; i < starts.length; i += 1) {
        const raw = parseIcimsCard(h.slice(starts[i], starts[i + 1]), host);
        expect(raw, `${file} card ${i}`).not.toBeNull();
        expect(raw?.id).toMatch(/^\d+$/);
        expect(raw?.title.length).toBeGreaterThan(3);
        expect(raw?.url).toBe(`https://${host}/jobs/${raw?.id}/${raw?.url.split('/')[5]}/job`.replace(/\/job$/, '/job'));
      }
    }
    const gdms = parseIcimsCard(fixture('gdms-search-p1.html').split('<li class="iCIMS_JobCardItem">')[1] ?? '', 'careers-gdms.icims.com');
    expect(gdms).toMatchObject({ id: '75463', title: 'Software/Systems Engineering Intern (Summer 2027)', location: 'US-RI-Middletown', reqId: '2026-75463' });
    expect(gdms?.postedText).toMatch(/^10\/8\/2026/);
  });

  it('extracts the JobPosting JSON-LD from a recorded job page', () => {
    const ld = parseIcimsJsonLd(fixture('gdms-job-72997.html'), 'icims:careers-gdms');
    expect(ld?.title).toBe('Satellite Communications Software Engineer | Software Defined Radio Engineer');
    expect(ld?.datePosted).toBe('2026-10-09T04:00:00.000Z');
    expect(ld?.hiringOrganization?.name).toContain('General Dynamics');
    expect(parseIcimsJsonLd('<html><body>nothing</body></html>', 'x')).toBeNull();
    expect(parseIcimsJsonLd('<script type="application/ld+json">{not json</script>', 'x')).toBeNull();
  });
});

describe('icims adapter: listJobs', () => {
  it('pages the mobile search until a page adds nothing new', async () => {
    const { calls, http } = fakeFetch((url) => {
      const pr = Number(/pr=(\d+)/.exec(url)?.[1]);
      if (pr === 0) return html(page(100, 20));
      if (pr === 1) return html(page(120, 7));
      return html(page(120, 7)); // iCIMS repeats the last page past the end
    });
    const jobs = await icimsAdapter.listJobs(board(), http);
    expect(jobs.map((j) => j.id).length).toBe(27);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain('pr=0&mobile=true&needsRedirect=false');
  });

  it('dedupes an id that shifted across pages', async () => {
    const { http } = fakeFetch((url) => {
      const pr = Number(/pr=(\d+)/.exec(url)?.[1]);
      if (pr === 0) return html(page(100, 20));
      if (pr === 1) return html(page(119, 3)); // 119 repeats
      return html(page(119, 3));
    });
    const jobs = await icimsAdapter.listJobs(board(), http);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
    expect(jobs).toHaveLength(22);
  });

  it('caps paging at ICIMS_MAX_PAGES when every page is new', async () => {
    const { http } = fakeFetch((url) => html(page(1000 * Number(/pr=(\d+)/.exec(url)?.[1]), 1)));
    await expect(icimsAdapter.listJobs(board(), http)).rejects.toThrow(`paging exceeded ${ICIMS_MAX_PAGES} pages`);
  });

  it('returns [] on 304 and for an empty search page', async () => {
    const { http: h304 } = fakeFetch(() => html('', 304));
    expect(await icimsAdapter.listJobs(board(), h304)).toEqual([]);
    const { http: hEmpty } = fakeFetch(() => html('<html><body><ul class="iCIMS_JobsTable"></ul><p>No Results Found</p></body></html>'));
    expect(await icimsAdapter.listJobs(board(), hEmpty)).toEqual([]);
  });

  it('fails the fetch (never closures) on a login wall or an unexpected page', async () => {
    const { http } = fakeFetch(() => html('<html><body><form id="login">Please sign in</form></body></html>'));
    await expect(icimsAdapter.listJobs(board(), http)).rejects.toMatchObject({ code: 'bad_json', host: 'careers-gdms.icims.com' });
  });

  it('surfaces a 403 as HttpError(forbidden)', async () => {
    const { http } = fakeFetch(() => html('<html>blocked</html>', 403));
    await expect(icimsAdapter.listJobs(board(), http)).rejects.toMatchObject({ code: 'forbidden', status: 403 });
  });

  it('lists the recorded fixtures through the client', async () => {
    const { http } = fakeFetch((url) => {
      const pr = Number(/pr=(\d+)/.exec(url)?.[1]);
      return html(pr === 0 ? fixture('gdms-search-p0.html') : pr === 1 ? fixture('gdms-search-p1.html') : fixture('gdms-search-p1.html'));
    });
    const jobs = await icimsAdapter.listJobs(board(), http);
    expect(jobs).toHaveLength(6);
    expect(jobs.map((j) => j.id)).toContain('75463');
  });

  it('refuses hosts outside the allowlist via the client', async () => {
    const { calls, http } = fakeFetch(() => html(page(1, 1)));
    await expect(icimsAdapter.listJobs(board('careers-gdms', 'https://evil.example/x'), http)).resolves.toBeDefined();
    expect(calls[0]).toContain('careers-gdms.icims.com');
  });
});

describe('icims adapter: fetchDetail and toInput', () => {
  const listed: IcimsRawJob = {
    id: '72997',
    title: 'Satellite Communications Software Engineer',
    url: 'https://careers-gdms.icims.com/jobs/72997/x/job',
    postedText: '10/9/2026 2:00 PM',
    location: 'US-AZ-Scottsdale',
    category: 'Engineering-Software',
    reqId: '2026-72997',
    employmentType: null,
    salaryText: 'USD $124,397.00 - USD $138,003.00 /Yr.',
    snippetHtml: "Bachelor's degree in Software Engineering",
  };

  it('merges the JSON-LD detail and maps the record', async () => {
    const { calls, http } = fakeFetch(() => html(fixture('gdms-job-72997.html')));
    const withDetail = await icimsAdapter.fetchDetail!(board(), listed, http);
    expect(calls[0]).toBe('https://careers-gdms.icims.com/jobs/72997/job?in_iframe=1');
    expect(withDetail.detail?.datePosted).toBe('2026-10-09T04:00:00.000Z');
    expect(withDetail.detail?.locations).toEqual(['Scottsdale, AZ, US']);
    const input = icimsAdapter.toInput(withDetail, board(), FIRST_SEEN);
    expect(JobPostingInputSchema.parse(input)).toEqual(input);
    expect(input).toMatchObject({
      externalId: '72997',
      internalReqId: '2026-72997',
      title: 'Satellite Communications Software Engineer | Software Defined Radio Engineer',
      locations: ['Scottsdale, AZ, US'],
      employmentType: null, // "OTHER" is dropped
      applyUrl: 'https://careers-gdms.icims.com/jobs/72997/job',
      postedAt: '2026-10-09T04:00:00.000Z',
      postedAtSource: 'ATS_FIELD',
      salary: { min: 124397, max: 138003, currency: 'USD', period: 'year' },
      department: 'Engineering-Software',
      applicationDeadline: '2027-10-09T04:00:00.000Z',
    });
    expect(input.descriptionHtml.length).toBeGreaterThan(200);
    expect(icimsAdapter.canonicalKey(withDetail, board())).toBe('icims:careers-gdms:72997');
  });

  it('maps a light posting from the list fields with the tooltip date', () => {
    const input = icimsAdapter.toInput(listed, board(), FIRST_SEEN);
    expect(input.postedAt).toBe('2026-10-09T14:00:00.000Z');
    expect(input.postedAtSource).toBe('ATS_FIELD');
    expect(input.locations).toEqual(['US-AZ-Scottsdale']);
    expect(input.descriptionHtml).toBe("Bachelor's degree in Software Engineering");
    const noDate = icimsAdapter.toInput({ ...listed, postedText: null }, board(), FIRST_SEEN);
    expect(noDate.postedAt).toBe(FIRST_SEEN.toISOString());
    expect(noDate.postedAtSource).toBe('FIRST_SEEN');
    expect(icimsAdapter.parsePostedAt(listed, FIRST_SEEN)?.toISOString()).toBe('2026-10-09T14:00:00.000Z');
  });

  it('keeps the raw job on a 304 detail or a page without structured data', async () => {
    const { http: h304 } = fakeFetch(() => html('', 304));
    expect(await icimsAdapter.fetchDetail!(board(), listed, h304)).toBe(listed);
    const { http: hNone } = fakeFetch(() => html('<html><body><div class="iCIMS_MainWrapper">no ld</div></body></html>'));
    expect(await icimsAdapter.fetchDetail!(board(), listed, hNone)).toEqual(listed);
  });

  it('rejects a JSON-LD block with the wrong shape, naming the board only', async () => {
    const { http } = fakeFetch(() => html('<script type="application/ld+json">{"@type":"JobPosting","title":5}</script>'));
    await expect(icimsAdapter.fetchDetail!(board(), listed, http)).rejects.toThrow(/^icims:careers-gdms json-ld: unexpected payload shape/);
  });

  it('passes a hostile card through unchanged for the sanitizer and link validator', () => {
    const card = `<li class="iCIMS_JobCardItem"><div class="col-xs-12 title"><a href="https://careers-gdms.icims.com/jobs/9/x/job" class="iCIMS_Anchor" title="9 - x"><h3>&lt;script&gt;alert(1)&lt;/script&gt; Intern</h3></a></div>
<div class="col-xs-12 description"><img src=x onerror=alert(1)>Apply at javascript:alert(1)</div></li>`;
    const raw = parseIcimsCard(card, 'careers-gdms.icims.com');
    expect(raw?.title).toBe('<script>alert(1)</script> Intern');
    const input = icimsAdapter.toInput(raw!, board(), FIRST_SEEN);
    expect(input.title).toBe('<script>alert(1)</script> Intern');
    expect(input.descriptionHtml).toContain('onerror');
    expect(input.applyUrl).toBe('https://careers-gdms.icims.com/jobs/9/job');
  });

  it('fails parsing on a card without an id or title', () => {
    expect(parseIcimsCard('<li class="iCIMS_JobCardItem">nothing here</li>', 'careers-gdms.icims.com')).toBeNull();
    expect(parseIcimsCard('<li class="iCIMS_JobCardItem"><a href="https://careers-gdms.icims.com/jobs/12/x/job"></a></li>', 'careers-gdms.icims.com')).toBeNull();
    expect(() => parseIcimsCard('<a href="https://careers-gdms.icims.com/jobs/abc/x/job" title="abc - T"><h3>T</h3></a>', 'careers-gdms.icims.com')).not.toThrow();
  });

  it('is an HttpError when the client refuses an off-host redirect', async () => {
    const { http } = fakeFetch(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }));
    await expect(icimsAdapter.listJobs(board(), http)).rejects.toBeInstanceOf(HttpError);
  });
});
