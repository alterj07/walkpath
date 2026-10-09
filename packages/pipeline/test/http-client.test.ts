import { describe, expect, it } from 'vitest';
import { HttpClient, HttpError, BOT_USER_AGENT, parseRetryAfter, type FetchLike } from '../src/http/client.ts';
import { HostLimiter } from '../src/http/limiter.ts';

interface Call {
  url: string;
  init: RequestInit;
  at: number;
}

/** Deterministic clock: sleep() advances time instead of waiting. */
function makeClock() {
  let t = 1_000_000;
  const now = () => t;
  const sleep = async (ms: number) => {
    t += ms;
  };
  return { now, sleep, advance: (ms: number) => (t += ms) };
}

function fakeFetch(handler: (url: string, init: RequestInit, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const clock = makeClock();
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init, at: clock.now() });
    return handler(url, init, calls.length);
  };
  return { calls, clock, fetchImpl };
}

function res(body: string, status = 200, headers: Record<string, string> = {}) {
  // 204/205/304 are null-body statuses; Response rejects a string body for them.
  return new Response(status === 304 || status === 204 || status === 205 ? null : body, { status, headers });
}

const limits = { minDelayMs: 0, maxConcurrency: 4 };
const allowedHosts = ['api.example.com', '*.example.com'];

function client(f: ReturnType<typeof fakeFetch>, extra: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}) {
  return new HttpClient({ fetch: f.fetchImpl, now: f.clock.now, sleep: f.clock.sleep, random: () => 0.5, respectRobots: false, ...extra });
}

describe('HttpClient basics', () => {
  it('sends the fixed user agent, manual redirect, and returns body + validators', async () => {
    const f = fakeFetch(() => res('{"a":1}', 200, { etag: 'W/"x"', 'last-modified': 'Thu, 01 Jan 2026 00:00:00 GMT' }));
    const r = await client(f).request({ url: 'https://api.example.com/jobs', allowedHosts, limits });
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"a":1}');
    expect(r.etag).toBe('W/"x"');
    expect(r.lastModified).toBe('Thu, 01 Jan 2026 00:00:00 GMT');
    expect(r.notModified).toBe(false);
    const init = f.calls[0]!.init;
    expect((init.headers as Record<string, string>)['user-agent']).toBe(BOT_USER_AGENT);
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses hosts outside the allowlist without fetching', async () => {
    const f = fakeFetch(() => res('x'));
    await expect(client(f).request({ url: 'https://evil.com/x', allowedHosts, limits })).rejects.toMatchObject({
      code: 'host_not_allowed',
    });
    expect(f.calls).toHaveLength(0);
  });

  it('getJson parses the body as unknown', async () => {
    const f = fakeFetch(() => res('{"jobs":[1,2]}'));
    const r = await client(f).getJson({ url: 'https://api.example.com/j', allowedHosts, limits });
    expect(r.data).toEqual({ jobs: [1, 2] });
    expect((f.calls[0]!.init.headers as Record<string, string>)['accept']).toBe('application/json');
  });

  it('getJson maps invalid JSON to bad_json without leaking the body', async () => {
    const f = fakeFetch(() => res('<html>SECRET-SNIPPET</html>'));
    const err = await client(f)
      .getJson({ url: 'https://api.example.com/j', allowedHosts, limits })
      .catch((e) => e as HttpError);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('bad_json');
    expect((err as HttpError).status).toBe(200);
    expect(String(err)).not.toContain('SECRET');
  });

  it('getJson returns data null on 304', async () => {
    const f = fakeFetch(() => res('', 304));
    const r = await client(f).getJson({ url: 'https://api.example.com/j', allowedHosts, limits, etag: '"e"' });
    expect(r.notModified).toBe(true);
    expect(r.data).toBeNull();
  });

  it('throws http_status on 4xx without retrying', async () => {
    const f = fakeFetch(() => res('nope', 404));
    await expect(client(f).request({ url: 'https://api.example.com/x', allowedHosts, limits })).rejects.toMatchObject({
      code: 'http_status',
      status: 404,
    });
    expect(f.calls).toHaveLength(1);
  });

  it('error messages never include bodies or headers', async () => {
    const f = fakeFetch(() => res('SECRET-BODY', 500, { 'x-secret': 'SECRET-HEADER' }));
    const err = await client(f).request({ url: 'https://api.example.com/x', allowedHosts, limits }).catch((e) => e as HttpError);
    expect(err).toBeInstanceOf(HttpError);
    expect(String(err)).not.toContain('SECRET');
  });
});

describe('conditional GET', () => {
  it('sends validators and reports 304 as notModified', async () => {
    const f = fakeFetch(() => res('', 304));
    const r = await client(f).request({
      url: 'https://api.example.com/jobs',
      allowedHosts,
      limits,
      etag: 'W/"abc"',
      lastModified: 'Thu, 01 Jan 2026 00:00:00 GMT',
    });
    expect(r.notModified).toBe(true);
    expect(r.body).toBe('');
    expect(r.etag).toBe('W/"abc"');
    const h = f.calls[0]!.init.headers as Record<string, string>;
    expect(h['if-none-match']).toBe('W/"abc"');
    expect(h['if-modified-since']).toBe('Thu, 01 Jan 2026 00:00:00 GMT');
  });
});

describe('redirects', () => {
  it('follows redirects within allowed hosts (max 3 hops)', async () => {
    const f = fakeFetch((url) => {
      if (url.endsWith('/a')) return res('', 301, { location: 'https://cdn.example.com/b' });
      if (url.endsWith('/b')) return res('', 302, { location: '/c' });
      return res('final');
    });
    const r = await client(f).request({ url: 'https://api.example.com/a', allowedHosts, limits });
    expect(r.body).toBe('final');
    expect(r.url).toBe('https://cdn.example.com/c');
    expect(f.calls.map((c) => c.url)).toEqual(['https://api.example.com/a', 'https://cdn.example.com/b', 'https://cdn.example.com/c']);
  });

  it('refuses a redirect to a host outside the allowlist', async () => {
    const f = fakeFetch(() => res('', 302, { location: 'https://attacker.net/steal' }));
    await expect(client(f).request({ url: 'https://api.example.com/a', allowedHosts, limits })).rejects.toMatchObject({
      code: 'redirect_not_allowed',
      host: 'attacker.net',
    });
    expect(f.calls).toHaveLength(1);
  });

  it('refuses non-http redirect targets', async () => {
    const f = fakeFetch(() => res('', 302, { location: 'javascript:alert(1)' }));
    await expect(client(f).request({ url: 'https://api.example.com/a', allowedHosts, limits })).rejects.toMatchObject({
      code: 'redirect_not_allowed',
    });
  });

  it('gives up after too many redirects', async () => {
    const f = fakeFetch((url) => res('', 302, { location: url + '/x' }));
    await expect(client(f).request({ url: 'https://api.example.com/a', allowedHosts, limits })).rejects.toMatchObject({
      code: 'too_many_redirects',
    });
    expect(f.calls).toHaveLength(4);
  });
});

describe('body cap', () => {
  it('rejects a declared oversize body before reading', async () => {
    const f = fakeFetch(() => res('x', 200, { 'content-length': String(10 * 1024 * 1024) }));
    await expect(client(f).request({ url: 'https://api.example.com/a', allowedHosts, limits })).rejects.toMatchObject({
      code: 'body_too_large',
    });
  });

  it('rejects a streamed body that grows past the cap', async () => {
    const chunk = new Uint8Array(1024).fill(65);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });
    const f = fakeFetch(() => new Response(stream, { status: 200 }));
    await expect(
      client(f, { maxBodyBytes: 4096 }).request({ url: 'https://api.example.com/a', allowedHosts, limits }),
    ).rejects.toMatchObject({ code: 'body_too_large' });
  });
});

describe('backoff and retry', () => {
  it('retries 5xx with exponential backoff and ±30% jitter, then succeeds', async () => {
    const f = fakeFetch((_u, _i, n) => (n < 3 ? res('err', 503) : res('ok')));
    const r = await client(f).request({ url: 'https://api.example.com/a', allowedHosts, limits });
    expect(r.body).toBe('ok');
    expect(f.calls).toHaveLength(3);
    // random() = 0.5 -> jitter factor 1.0 -> delays 1000 then 2000
    expect(f.calls[1]!.at - f.calls[0]!.at).toBe(1000);
    expect(f.calls[2]!.at - f.calls[1]!.at).toBe(2000);
  });

  it('applies jitter from random()', async () => {
    const f = fakeFetch((_u, _i, n) => (n < 2 ? res('err', 500) : res('ok')));
    await client(f, { random: () => 1 }).request({ url: 'https://api.example.com/a', allowedHosts, limits });
    expect(f.calls[1]!.at - f.calls[0]!.at).toBe(1300);
  });

  it('honours Retry-After seconds on 429', async () => {
    const f = fakeFetch((_u, _i, n) => (n < 2 ? res('slow', 429, { 'retry-after': '7' }) : res('ok')));
    await client(f).request({ url: 'https://api.example.com/a', allowedHosts, limits });
    expect(f.calls[1]!.at - f.calls[0]!.at).toBe(7000);
  });

  it('honours Retry-After as an HTTP date', async () => {
    const f = fakeFetch((_u, _i, n) =>
      n < 2 ? res('slow', 429, { 'retry-after': new Date(f.clock.now() + 9000).toUTCString() }) : res('ok'),
    );
    await client(f).request({ url: 'https://api.example.com/a', allowedHosts, limits });
    expect(f.calls[1]!.at - f.calls[0]!.at).toBe(9000);
  });

  it('a Retry-After above 60 s blocks the host for the full value and skips the board this run', async () => {
    const f = fakeFetch((url) => (url.endsWith('/a') ? res('slow', 429, { 'retry-after': '600' }) : res('ok')));
    const c = client(f);
    const t0 = f.clock.now();
    await expect(c.request({ url: 'https://api.example.com/a', allowedHosts, limits })).rejects.toMatchObject({
      code: 'retry_exhausted',
      status: 429,
    });
    expect(f.calls).toHaveLength(1);
    expect(f.clock.now()).toBe(t0); // no waiting inside the run
    // The host stays blocked for the full 600 s: the next request to it only starts after that.
    await c.request({ url: 'https://api.example.com/b', allowedHosts, limits });
    expect(f.calls[1]!.at - t0).toBe(600_000);
  });

  it('gives up after 4 attempts with retry_exhausted', async () => {
    const f = fakeFetch(() => res('err', 502));
    await expect(client(f).request({ url: 'https://api.example.com/a', allowedHosts, limits })).rejects.toMatchObject({
      code: 'retry_exhausted',
      status: 502,
    });
    expect(f.calls).toHaveLength(4);
  });

  it('a backoff on one host delays sibling requests to the same host', async () => {
    const f = fakeFetch((url, _i, n) => (url.endsWith('/a') && n === 1 ? res('err', 503) : res('ok')));
    const c = client(f);
    await c.request({ url: 'https://api.example.com/a', allowedHosts, limits });
    const t0 = f.clock.now();
    await c.request({ url: 'https://api.example.com/b', allowedHosts, limits });
    expect(f.calls.at(-1)!.at).toBe(t0); // backoff window already elapsed during the retry
    expect(f.calls).toHaveLength(3);
  });

  it('maps a timeout abort to a timeout error and retries it', async () => {
    let n = 0;
    const f = fakeFetch(async (_u, init) => {
      n += 1;
      if (n === 1) {
        // Simulate the abort firing: reject the way undici does.
        (init.signal as AbortSignal).dispatchEvent(new Event('abort'));
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      return res('ok');
    });
    // Our fake rejects before the timer fires; emulate the aborted signal check via a short timeout.
    const c = new HttpClient({
      fetch: async (u, init) => {
        if (n === 0) {
          n += 1;
          // Force the controller's abort so the client classifies it as timeout.
          await new Promise((r) => setTimeout(r, 2));
          if (!(init.signal as AbortSignal).aborted) throw new Error('expected abort');
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
        return f.fetchImpl(u, init);
      },
      now: f.clock.now,
      sleep: f.clock.sleep,
      random: () => 0.5,
      respectRobots: false,
      timeoutMs: 1,
    });
    const r = await c.request({ url: 'https://api.example.com/a', allowedHosts, limits });
    expect(r.body).toBe('ok');
  });
});

describe('timeout covers the body', () => {
  function stallingStream(firstChunk: Uint8Array) {
    let pulled = false;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!pulled) {
          pulled = true;
          controller.enqueue(firstChunk);
          return;
        }
        return new Promise(() => undefined); // never resolves: a stalled body
      },
    });
  }

  it('a stalled body surfaces as a timeout, goes through retry, and never leaks AbortError', async () => {
    let n = 0;
    const clock = makeClock();
    const c = new HttpClient({
      fetch: async () => {
        n += 1;
        if (n === 1) return new Response(stallingStream(new Uint8Array([65])), { status: 200 });
        return res('ok');
      },
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0.5,
      respectRobots: false,
      timeoutMs: 5,
    });
    const r = await c.request({ url: 'https://api.example.com/a', allowedHosts, limits });
    expect(r.body).toBe('ok');
    expect(n).toBe(2);
  });

  it('a body that stalls on every attempt ends as a timeout error, not AbortError', async () => {
    const clock = makeClock();
    const c = new HttpClient({
      fetch: async () => new Response(stallingStream(new Uint8Array([65])), { status: 200 }),
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0.5,
      respectRobots: false,
      timeoutMs: 2,
    });
    const err = await c.request({ url: 'https://api.example.com/a', allowedHosts, limits }).catch((e) => e as HttpError);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('timeout');
  });
});

describe('robots.txt', () => {
  it('per-request respectRobots:false skips robots entirely (the SmartRecruiters exception)', async () => {
    const f = fakeFetch((url) => (url.endsWith('/robots.txt') ? res('User-agent: *\nDisallow: /\n') : res('ok')));
    const c = client(f, { respectRobots: true });
    await expect(c.request({ url: 'https://api.example.com/v1/x', allowedHosts, limits })).rejects.toMatchObject({
      code: 'robots_disallowed',
    });
    const r = await c.request({ url: 'https://api.example.com/v1/x', allowedHosts, limits, respectRobots: false });
    expect(r.body).toBe('ok');
    expect(f.calls.filter((x) => x.url.endsWith('/robots.txt'))).toHaveLength(1);
  });

  it('concurrent first requests share one robots.txt fetch', async () => {
    const f = fakeFetch((url) => (url.endsWith('/robots.txt') ? res('User-agent: *\nDisallow: /embed/\n') : res('ok')));
    const c = client(f, { respectRobots: true });
    const reqs = ['a', 'b', 'c'].map((p) => c.request({ url: `https://api.example.com/${p}`, allowedHosts, limits }));
    await Promise.all(reqs);
    expect(f.calls.filter((x) => x.url.endsWith('/robots.txt'))).toHaveLength(1);
    expect(f.calls).toHaveLength(4);
  });

  it('follows a same-host-family redirect for robots.txt but not one elsewhere', async () => {
    const f = fakeFetch((url) => {
      if (url === 'https://api.example.com/robots.txt') return res('', 301, { location: 'https://www.api.example.com/robots.txt' });
      if (url === 'https://www.api.example.com/robots.txt') return res('User-agent: *\nDisallow: /embed/\n');
      return res('ok');
    });
    const c = client(f, { respectRobots: true });
    await expect(c.request({ url: 'https://api.example.com/embed/x', allowedHosts, limits })).rejects.toMatchObject({
      code: 'robots_disallowed',
    });

    const g = fakeFetch((url) => {
      if (url.endsWith('/robots.txt')) return res('', 301, { location: 'https://other.example.com/robots.txt' });
      return res('ok');
    });
    const d = client(g, { respectRobots: true });
    const r = await d.request({ url: 'https://api.example.com/embed/x', allowedHosts, limits });
    expect(r.body).toBe('ok');
    expect(g.calls.filter((x) => x.url.endsWith('/robots.txt'))).toHaveLength(1);
  });

  it('a 5xx robots.txt means no rules for this run', async () => {
    const f = fakeFetch((url) => (url.endsWith('/robots.txt') ? res('err', 503) : res('ok')));
    const r = await client(f, { respectRobots: true }).request({ url: 'https://api.example.com/x', allowedHosts, limits });
    expect(r.body).toBe('ok');
    expect(f.calls.filter((x) => x.url.endsWith('/robots.txt'))).toHaveLength(1);
  });

  it('Crawl-delay does not mutate the caller\'s limits object', async () => {
    const f = fakeFetch((url) => (url.endsWith('/robots.txt') ? res('User-agent: *\nCrawl-delay: 9\n') : res('ok')));
    const myLimits = { minDelayMs: 0, maxConcurrency: 1 };
    const req = { url: 'https://api.example.com/a', allowedHosts, limits: myLimits };
    await client(f, { respectRobots: true }).request(req);
    expect(myLimits).toEqual({ minDelayMs: 0, maxConcurrency: 1 });
    expect(req.limits).toBe(myLimits);
  });

  it('fetches robots once per host, caches it, and blocks disallowed paths', async () => {
    const f = fakeFetch((url) => {
      if (url.endsWith('/robots.txt')) return res('User-agent: *\nDisallow: /embed/\nCrawl-delay: 3\n');
      return res('ok');
    });
    const c = client(f, { respectRobots: true });
    const r = await c.request({ url: 'https://api.example.com/v1/jobs', allowedHosts, limits });
    expect(r.body).toBe('ok');
    await expect(c.request({ url: 'https://api.example.com/embed/x', allowedHosts, limits })).rejects.toMatchObject({
      code: 'robots_disallowed',
    });
    await c.request({ url: 'https://api.example.com/v1/other', allowedHosts, limits });
    expect(f.calls.filter((x) => x.url.endsWith('/robots.txt'))).toHaveLength(1);
  });

  it('a missing robots.txt allows everything', async () => {
    const f = fakeFetch((url) => (url.endsWith('/robots.txt') ? res('', 404) : res('ok')));
    const r = await client(f, { respectRobots: true }).request({ url: 'https://api.example.com/x', allowedHosts, limits });
    expect(r.body).toBe('ok');
  });

  it('raises the per-host delay to Crawl-delay', async () => {
    const f = fakeFetch((url) => {
      if (url.endsWith('/robots.txt')) return res('User-agent: WalkPathBot\nCrawl-delay: 2\n');
      return res('ok');
    });
    const c = client(f, { respectRobots: true });
    const req = { url: 'https://api.example.com/a', allowedHosts, limits: { minDelayMs: 0, maxConcurrency: 1 } };
    await c.request(req);
    await c.request({ ...req, url: 'https://api.example.com/b' });
    const [, a, b] = f.calls; // index 0 is robots.txt
    expect(b!.at - a!.at).toBe(2000);
  });

  it('re-fetches robots after 24 h', async () => {
    const f = fakeFetch((url) => (url.endsWith('/robots.txt') ? res('') : res('ok')));
    const c = client(f, { respectRobots: true });
    await c.request({ url: 'https://api.example.com/a', allowedHosts, limits });
    f.clock.advance(25 * 60 * 60 * 1000);
    await c.request({ url: 'https://api.example.com/b', allowedHosts, limits });
    expect(f.calls.filter((x) => x.url.endsWith('/robots.txt'))).toHaveLength(2);
  });
});

describe('HostLimiter', () => {
  it('spaces requests by minDelayMs per host and serialises at maxConcurrency', async () => {
    const clock = makeClock();
    const lim = new HostLimiter(clock.now, clock.sleep);
    const starts: number[] = [];
    const l = { minDelayMs: 1000, maxConcurrency: 1 };
    for (let i = 0; i < 3; i += 1) {
      const release = await lim.acquire('h', l);
      starts.push(clock.now());
      release();
    }
    expect(starts[1]! - starts[0]!).toBe(1000);
    expect(starts[2]! - starts[1]!).toBe(1000);
  });

  it('limits concurrency and releases queued callers in order', async () => {
    const clock = makeClock();
    const lim = new HostLimiter(clock.now, clock.sleep);
    const l = { minDelayMs: 0, maxConcurrency: 2 };
    const order: string[] = [];
    const r1 = await lim.acquire('h', l);
    const r2 = await lim.acquire('h', l);
    const p3 = lim.acquire('h', l).then((r) => {
      order.push('3');
      return r;
    });
    const p4 = lim.acquire('h', l).then((r) => {
      order.push('4');
      return r;
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    r1();
    const r3 = await p3;
    expect(order).toEqual(['3']);
    r2();
    const r4 = await p4;
    expect(order).toEqual(['3', '4']);
    r3();
    r4();
  });

  it('hosts are independent', async () => {
    const clock = makeClock();
    const lim = new HostLimiter(clock.now, clock.sleep);
    const l = { minDelayMs: 5000, maxConcurrency: 1 };
    const t0 = clock.now();
    (await lim.acquire('a', l))();
    (await lim.acquire('b', l))();
    expect(clock.now()).toBe(t0);
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds, dates and garbage', () => {
    expect(parseRetryAfter('5', 0)).toBe(5000);
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:10 GMT', Date.parse('Thu, 01 Jan 2026 00:00:00 GMT'))).toBe(10_000);
    expect(parseRetryAfter('soon', 0)).toBeNull();
    expect(parseRetryAfter(null, 0)).toBeNull();
  });
});
