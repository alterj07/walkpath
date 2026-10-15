import { describe, expect, it } from 'vitest';
import { PoliteLimiter, classifyProbe, probeBoard, probeHost, probeRequest } from '../../src/registry/probe.ts';

describe('probeRequest', () => {
  it('builds the documented endpoint per ATS', () => {
    expect(probeRequest({ ats: 'greenhouse', boardKey: 'figma' }).url).toBe('https://boards-api.greenhouse.io/v1/boards/figma/jobs');
    expect(probeRequest({ ats: 'lever', boardKey: 'palantir' }).url).toBe('https://api.lever.co/v0/postings/palantir?mode=json&limit=1');
    expect(probeRequest({ ats: 'lever', boardKey: 'eu:wise' }).url).toBe('https://api.eu.lever.co/v0/postings/wise?mode=json&limit=1');
    expect(probeRequest({ ats: 'ashby', boardKey: 'notion' }).url).toBe('https://api.ashbyhq.com/posting-api/job-board/notion');
    expect(probeRequest({ ats: 'workable', boardKey: 'pony-dot-ai' }).url).toBe('https://apply.workable.com/api/v1/widget/accounts/pony-dot-ai?details=false');
    expect(probeRequest({ ats: 'smartrecruiters', boardKey: 'BoschGroup' }).url).toBe('https://api.smartrecruiters.com/v1/companies/BoschGroup/postings?limit=1');
    const wd = probeRequest({ ats: 'workday', boardKey: 'nvidia/NVIDIAExternalCareerSite', wd: 5 });
    expect(wd.url).toBe('https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs');
    expect(wd.init.method).toBe('POST');
    expect(JSON.parse(wd.init.body as string)).toEqual({ appliedFacets: {}, limit: 1, offset: 0, searchText: '' });
  });

  it('sends our User-Agent and encodes odd keys', () => {
    const req = probeRequest({ ats: 'greenhouse', boardKey: 'a b' });
    expect(req.url).toContain('/boards/a%20b/');
    expect((req.init.headers as Record<string, string>)['user-agent']).toMatch(/^WalkPathBot\//);
  });

  it('rejects workday targets without tenant/site or wd', () => {
    expect(() => probeRequest({ ats: 'workday', boardKey: 'nvidia', wd: 5 })).toThrow(/tenant\/site/);
    expect(() => probeRequest({ ats: 'workday', boardKey: 'nvidia/x' })).toThrow(/wd/);
  });

  it('probeHost returns the request host', () => {
    expect(probeHost({ ats: 'workday', boardKey: 'caci/external', wd: 1 })).toBe('caci.wd1.myworkdayjobs.com');
  });
});

describe('classifyProbe', () => {
  it('marks a 200 JSON body with the expected shape active', () => {
    expect(classifyProbe({ ats: 'greenhouse', boardKey: 'x' }, 200, '{"jobs":[],"meta":{"total":0}}')).toMatchObject({ verdict: 'active' });
    expect(classifyProbe({ ats: 'lever', boardKey: 'x' }, 200, '[]')).toMatchObject({ verdict: 'active' });
    expect(classifyProbe({ ats: 'workday', boardKey: 'a/b', wd: 1 }, 200, '{"total":3,"jobPostings":[]}')).toMatchObject({ verdict: 'active' });
  });

  it('extracts the company domain from a Greenhouse absolute_url on a company domain', () => {
    const body = '{"jobs":[{"absolute_url":"https://www.figma.com/careers/job/123","id":1}]}';
    expect(classifyProbe({ ats: 'greenhouse', boardKey: 'figma' }, 200, body).domain).toBe('figma.com');
    const hosted = '{"jobs":[{"absolute_url":"https://job-boards.greenhouse.io/figma/jobs/123"}]}';
    expect(classifyProbe({ ats: 'greenhouse', boardKey: 'figma' }, 200, hosted).domain).toBeUndefined();
    // A query string straight after the host must not leak into the domain.
    const query = '{"jobs":[{"absolute_url":"https://codal.jobs?gh_jid=5399459008"}]}';
    expect(classifyProbe({ ats: 'greenhouse', boardKey: 'codalinc' }, 200, query).domain).toBe('codal.jobs');
    const port = '{"jobs":[{"absolute_url":"https://WWW.Acme.com:443/jobs/1"}]}';
    expect(classifyProbe({ ats: 'greenhouse', boardKey: 'acme' }, 200, port).domain).toBe('acme.com');
  });

  it('extracts the Workable account name', () => {
    expect(classifyProbe({ ats: 'workable', boardKey: 'x' }, 200, '{"name":"Pony \\"AI\\"","description":"..."}').name).toBe('Pony "AI"');
  });

  it('drops 404s; everything else needs refingerprinting', () => {
    expect(classifyProbe({ ats: 'lever', boardKey: 'x' }, 404, '').verdict).toBe('drop');
    expect(classifyProbe({ ats: 'workable', boardKey: 'x' }, 404, '').verdict).toBe('drop');
    expect(classifyProbe({ ats: 'workable', boardKey: 'x' }, 302, '').verdict).toBe('needs_refingerprint');
    expect(classifyProbe({ ats: 'greenhouse', boardKey: 'x' }, 302, '').verdict).toBe('needs_refingerprint');
    expect(classifyProbe({ ats: 'greenhouse', boardKey: 'x' }, 403, '').verdict).toBe('needs_refingerprint');
    expect(classifyProbe({ ats: 'greenhouse', boardKey: 'x' }, 429, '').verdict).toBe('needs_refingerprint');
    expect(classifyProbe({ ats: 'greenhouse', boardKey: 'x' }, 200, '<html>').verdict).toBe('needs_refingerprint');
    expect(classifyProbe({ ats: 'greenhouse', boardKey: 'x' }, 200, '{"error":"x"}').verdict).toBe('needs_refingerprint');
    expect(classifyProbe({ ats: 'greenhouse', boardKey: 'x' }, 0, '').verdict).toBe('needs_refingerprint');
  });
});

describe('probeBoard', () => {
  it('reads only a prefix of a huge body and cancels the stream', async () => {
    let cancelled = false;
    const big = `{"jobs":[${'{"id":1},'.repeat(200_000)}{"id":2}]}`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(big);
        for (let i = 0; i < bytes.length; i += 16_384) controller.enqueue(bytes.subarray(i, i + 16_384));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const fake = async () => new Response(stream, { status: 200 });
    const result = await probeBoard({ ats: 'greenhouse', boardKey: 'x' }, fake);
    expect(result.verdict).toBe('active');
    expect(cancelled).toBe(true);
  });

  it('retries a Lever 404 once on api.eu.lever.co and re-keys the board', async () => {
    const urls: string[] = [];
    const fake = async (url: string) => {
      urls.push(url);
      return url.includes('api.eu.lever.co') ? new Response('[]', { status: 200 }) : new Response('', { status: 404 });
    };
    const result = await probeBoard({ ats: 'lever', boardKey: 'wise' }, fake);
    expect(result).toMatchObject({ verdict: 'active', resolvedBoardKey: 'eu:wise' });
    expect(urls).toEqual([
      'https://api.lever.co/v0/postings/wise?mode=json&limit=1',
      'https://api.eu.lever.co/v0/postings/wise?mode=json&limit=1',
    ]);
  });

  it('drops a Lever site that 404s in both regions, and never retries an eu: key', async () => {
    const urls: string[] = [];
    const fake = async (url: string) => {
      urls.push(url);
      return new Response('', { status: 404 });
    };
    expect((await probeBoard({ ats: 'lever', boardKey: 'gone' }, fake)).verdict).toBe('drop');
    expect(urls).toHaveLength(2);
    expect((await probeBoard({ ats: 'lever', boardKey: 'eu:gone' }, fake)).verdict).toBe('drop');
    expect(urls).toHaveLength(3);
  });

  it('confirms an empty SmartRecruiters board through the careers page', async () => {
    const empty = '{"offset":0,"limit":1,"totalFound":0,"content":[]}';
    const run = async (careers: () => Response) => {
      const urls: string[] = [];
      const fake = async (url: string) => {
        urls.push(url);
        return url.startsWith('https://careers.smartrecruiters.com/') ? careers() : new Response(empty, { status: 200 });
      };
      return { result: await probeBoard({ ats: 'smartrecruiters', boardKey: 'Acme' }, fake), urls };
    };
    // Company page exists.
    const a = await run(() => new Response('<html>', { status: 200 }));
    expect(a.result.verdict).toBe('active');
    expect(a.urls[1]).toBe('https://careers.smartrecruiters.com/Acme');
    // Redirect to the company's own site: exists, and we learn the domain.
    const b = await run(() => new Response(null, { status: 302, headers: { location: 'https://jobs.bosch.com/en' } }));
    expect(b.result).toMatchObject({ verdict: 'active', domain: 'jobs.bosch.com' });
    // Redirect to the generic root: unknown company.
    const c = await run(() => new Response(null, { status: 302, headers: { location: 'https://jobs.smartrecruiters.com' } }));
    expect(c.result.verdict).toBe('drop');
    // A board with postings never needs the second request.
    const urls: string[] = [];
    const fake = async (url: string) => {
      urls.push(url);
      return new Response('{"offset":0,"limit":1,"totalFound":12,"content":[{}]}', { status: 200 });
    };
    expect((await probeBoard({ ats: 'smartrecruiters', boardKey: 'Acme' }, fake)).verdict).toBe('active');
    expect(urls).toHaveLength(1);
  });

  it('retries once after a 429, honouring Retry-After', async () => {
    let calls = 0;
    const fake = async () => {
      calls += 1;
      return calls === 1 ? new Response(null, { status: 429, headers: { 'retry-after': '1' } }) : new Response('{"jobs":[]}', { status: 200 });
    };
    const started = Date.now();
    const result = await probeBoard({ ats: 'workable', boardKey: 'x' }, fake);
    expect(result.verdict).toBe('active');
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('turns network errors into needs_refingerprint with status 0', async () => {
    const fake = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await probeBoard({ ats: 'ashby', boardKey: 'x' }, fake)).toMatchObject({ verdict: 'needs_refingerprint', status: 0 });
  });

  it('passes redirect: manual so redirects are observed instead of followed off-host', async () => {
    let seenInit: RequestInit | undefined;
    const fake = async (_url: string, init: RequestInit) => {
      seenInit = init;
      return new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
    };
    expect((await probeBoard({ ats: 'workable', boardKey: 'nope' }, fake)).verdict).toBe('needs_refingerprint');
    expect(seenInit?.redirect).toBe('manual');
  });
});

describe('PoliteLimiter', () => {
  it('caps concurrency per host and globally', async () => {
    const limiter = new PoliteLimiter(3, (host) => (host === 'slow' ? { maxConcurrency: 1, minGapMs: 0 } : { maxConcurrency: 5, minGapMs: 0 }));
    let active = 0;
    let maxActive = 0;
    let slowActive = 0;
    let maxSlow = 0;
    const task = (host: string) =>
      limiter.run(host, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (host === 'slow') {
          slowActive += 1;
          maxSlow = Math.max(maxSlow, slowActive);
        }
        await new Promise((r) => setTimeout(r, 5));
        if (host === 'slow') slowActive -= 1;
        active -= 1;
      });
    await Promise.all([...Array.from({ length: 6 }, () => task('fast')), ...Array.from({ length: 4 }, () => task('slow'))]);
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxSlow).toBe(1);
  });

  it('spaces request starts on the same host by minGapMs', async () => {
    const limiter = new PoliteLimiter(10, () => ({ maxConcurrency: 5, minGapMs: 30 }));
    const starts: number[] = [];
    await Promise.all(Array.from({ length: 3 }, () => limiter.run('h', async () => void starts.push(Date.now()))));
    starts.sort((a, b) => a - b);
    expect((starts[1] as number) - (starts[0] as number)).toBeGreaterThanOrEqual(25);
    expect((starts[2] as number) - (starts[1] as number)).toBeGreaterThanOrEqual(25);
  });
});


describe('oracle probe', () => {
  it('builds a limit=1 list request and classifies the markers', () => {
    const target = { ats: 'oracle' as const, boardKey: 'eeho.fa.us2.oraclecloud.com/CX_45001' };
    expect(probeRequest(target).url).toBe(
      'https://eeho.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&finder=findReqs;siteNumber=CX_45001,limit=1,offset=0,sortBy=POSTING_DATES_DESC',
    );
    expect(classifyProbe(target, 200, '{"items":[{"TotalJobsCount":12,"requisitionList":[]}]}').verdict).toBe('active');
    expect(classifyProbe(target, 404, 'Not Found').verdict).toBe('drop');
    expect(() => probeRequest({ ats: 'oracle', boardKey: 'evil.example.com/CX_1' })).toThrow(/oraclecloud\.com/);
  });
});
