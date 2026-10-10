import { describe, expect, it } from 'vitest';
import { HttpClient, type FetchLike } from '../src/http/client.ts';

/** Deterministic clock: sleep() advances time instead of waiting. */
function makeClock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

function fakeFetch(handler: (url: string, n: number) => Response) {
  const calls: Array<{ url: string; at: number }> = [];
  const clock = makeClock();
  const fetchImpl: FetchLike = async (url) => {
    calls.push({ url, at: clock.now() });
    return handler(url, calls.length);
  };
  return { calls, clock, fetchImpl };
}

const res = (body: string, status = 200) => new Response(body, { status });
const limits = { minDelayMs: 0, maxConcurrency: 4 };
const allowedHosts = ['api.example.com', '*.example.com'];
const reqFor = (path: string) => ({ url: `https://api.example.com/${path}`, allowedHosts, limits });

function client(f: ReturnType<typeof fakeFetch>) {
  return new HttpClient({ fetch: f.fetchImpl, now: f.clock.now, sleep: f.clock.sleep, random: () => 0.5, respectRobots: false });
}

describe('HttpClient host circuit breaker', () => {
  it('cools the host down after a 403 on an escalating schedule and opens the circuit after three', async () => {
    const f = fakeFetch(() => res('<html>blocked</html>', 403));
    const c = client(f);
    const t0 = f.clock.now();
    await expect(c.request(reqFor('a'))).rejects.toMatchObject({ code: 'forbidden' });
    expect(c.hostHealth()['api.example.com']).toMatchObject({
      consecutive_blocks: 1,
      circuit_open: false,
      blocked_until: t0 + 2 * 60_000,
    });
    // The second request waits out the 2 min cooldown (virtual clock), then is blocked again.
    await expect(c.request(reqFor('b'))).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.calls[1]!.at - t0).toBeGreaterThanOrEqual(2 * 60_000);
    expect(c.hostHealth()['api.example.com']!.consecutive_blocks).toBe(2);
    await expect(c.request(reqFor('c'))).rejects.toMatchObject({ code: 'forbidden' });
    const h = c.hostHealth()['api.example.com']!;
    expect(h.consecutive_blocks).toBe(3);
    expect(h.circuit_open).toBe(true);
    // From now on nothing is sent to that host.
    await expect(c.request(reqFor('d'))).rejects.toMatchObject({ code: 'circuit_open', status: 403 });
    await expect(c.getJson(reqFor('e'))).rejects.toMatchObject({ code: 'circuit_open' });
    expect(f.calls).toHaveLength(3);
    expect(c.hostHealth()['api.example.com']!.rejected).toBe(2);
  });

  it('a success resets the consecutive-block count', async () => {
    const f = fakeFetch((_u, n) => (n === 1 ? res('x', 403) : res('{"ok":true}')));
    const c = client(f);
    await expect(c.request(reqFor('a'))).rejects.toMatchObject({ code: 'forbidden' });
    const r = await c.request(reqFor('b'));
    expect(r.status).toBe(200);
    expect(c.hostHealth()['api.example.com']).toMatchObject({ consecutive_blocks: 0, circuit_open: false });
  });

  it('an exhausted retry budget counts as a block too', async () => {
    const f = fakeFetch(() => res('busy', 429));
    const c = client(f);
    await expect(c.request(reqFor('a'))).rejects.toMatchObject({ code: 'retry_exhausted' });
    expect(c.hostHealth()['api.example.com']!.consecutive_blocks).toBe(1);
  });

  it('the breaker is per host', async () => {
    const f = fakeFetch((url) => (url.includes('api.example.com') ? res('x', 403) : res('ok')));
    const c = client(f);
    for (const p of ['a', 'b', 'c']) await expect(c.request(reqFor(p))).rejects.toMatchObject({ code: 'forbidden' });
    const r = await c.request({ url: 'https://other.example.com/x', allowedHosts, limits });
    expect(r.status).toBe(200);
    expect(c.hostHealth()['other.example.com']).toMatchObject({ consecutive_blocks: 0, circuit_open: false });
  });
});
