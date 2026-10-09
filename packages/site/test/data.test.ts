import { describe, expect, it } from 'vitest';
import {
  absoluteTime,
  indexFileFor,
  isIndexRow,
  loadIndexFile,
  locationLabel,
  logoUrl,
  parseIndexFile,
  parseMeta,
  relativeTime,
  windowStartMs,
} from '../src/lib/data.ts';

const NOW = Date.parse('2026-10-09T18:00:00Z');

const row = {
  id: 'a9f3c2e17b04',
  title: 'Flight Software Intern Summer 2027',
  company: 'Example Rockets',
  slug: 'example-rockets',
  domain: 'example-rockets.test',
  city: 'Littleton',
  state: 'CO',
  arrangement: 'in_person',
  family: 'hardware_embedded',
  season: 'Summer 2027',
  posted_at: '2026-10-09T14:14:00Z',
  first_seen_at: '2026-10-09T14:31:07Z',
  ats: 'workday',
  has_salary: true,
  citizenship_required: true,
  others: 2,
};

describe('relativeTime', () => {
  it('formats minutes, hours and days', () => {
    expect(relativeTime('2026-10-09T17:59:40Z', NOW)).toBe('just now');
    expect(relativeTime('2026-10-09T17:30:00Z', NOW)).toBe('30 min ago');
    expect(relativeTime('2026-10-09T15:00:00Z', NOW)).toBe('3 h ago');
    expect(relativeTime('2026-10-06T18:00:00Z', NOW)).toBe('3 d ago');
    expect(relativeTime('2026-08-01T00:00:00Z', NOW)).toBe('2026-08-01');
    expect(relativeTime('garbage', NOW)).toBe('');
  });

  it('treats slightly-future timestamps as now but shows the date beyond 5 minutes', () => {
    expect(relativeTime('2026-10-09T18:03:00Z', NOW)).toBe('just now');
    expect(relativeTime('2026-10-10T00:00:00Z', NOW)).toBe('2026-10-10');
  });

  it('absoluteTime is UTC minute precision', () => {
    expect(absoluteTime('2026-10-09T14:14:33.123Z')).toBe('2026-10-09 14:14 UTC');
    expect(absoluteTime('nope')).toBe('');
  });
});

describe('windows', () => {
  it('maps windows to index files', () => {
    expect(indexFileFor('1h')).toBe('latest');
    expect(indexFileFor('24h')).toBe('latest');
    expect(indexFileFor('3d')).toBe('7d');
    expect(indexFileFor('7d')).toBe('7d');
    expect(indexFileFor('30d')).toBe('all');
  });

  it('computes window starts', () => {
    expect(NOW - windowStartMs('1h', NOW)).toBe(3_600_000);
    expect(NOW - windowStartMs('24h', NOW)).toBe(86_400_000);
    expect(NOW - windowStartMs('30d', NOW)).toBe(30 * 86_400_000);
  });
});

describe('guards', () => {
  it('accepts a well-formed row and ignores extra keys', () => {
    expect(isIndexRow({ ...row, extra: 1 })).toBe(true);
  });

  it('rejects malformed rows', () => {
    expect(isIndexRow({ ...row, id: 'A9F3C2E17B04' })).toBe(false);
    expect(isIndexRow({ ...row, id: 'a9f3c2e17b0' })).toBe(false);
    expect(isIndexRow({ ...row, title: '' })).toBe(false);
    expect(isIndexRow({ ...row, family: 'marketing' })).toBe(false);
    expect(isIndexRow({ ...row, arrangement: 'onsite' })).toBe(false);
    expect(isIndexRow({ ...row, posted_at: 'yesterday' })).toBe(false);
    expect(isIndexRow({ ...row, others: -1 })).toBe(false);
    expect(isIndexRow({ ...row, citizenship_required: 'yes' })).toBe(false);
    expect(isIndexRow({ ...row, title: 'x'.repeat(501) })).toBe(false);
    expect(isIndexRow(null)).toBe(false);
    expect(isIndexRow('row')).toBe(false);
  });

  it('parseIndexFile drops bad rows and unknown keys', () => {
    const parsed = parseIndexFile({ generated_at: '2026-10-09T17:17:00Z', rows: [row, { ...row, id: 'bad' }, 'junk', { ...row, extra: 'x' }] });
    expect(parsed.generated_at).toBe('2026-10-09T17:17:00Z');
    expect(parsed.rows).toHaveLength(2);
    expect(Object.keys(parsed.rows[1] ?? {})).not.toContain('extra');
    expect(parseIndexFile(null)).toEqual({ generated_at: '', rows: [] });
    expect(parseIndexFile({ rows: 'no' }).rows).toEqual([]);
  });

  it('parseMeta validates the shape and fills defaults', () => {
    const meta = parseMeta({
      last_run_at: '2026-10-09T17:17:00Z',
      run_id: 'api-2026-10-09T17',
      boards: { greenhouse: { polled: 10, ok: 9, failed: 1 }, bad: { polled: 'x' } },
      jobs: { open: 3000, new: 40, closed: 12 },
      latency: { median_min: 22, p90_min: null },
      llm: { mistral: { requests: 40, tokens: 90000 } },
      pending_summaries: 2,
      held_for_review: 0,
    });
    expect(meta).not.toBeNull();
    // Valid entries are kept; the malformed one is dropped.
    expect(meta?.boards).toEqual({ greenhouse: { polled: 10, ok: 9, failed: 1 } });
    expect(meta?.latency).toEqual({ median_min: 22, p90_min: null });
    expect(meta?.schedule.started_at).toBe('2026-10-09T17:17:00Z');
    expect(meta?.llm.mistral?.tokens).toBe(90000);
    expect(parseMeta({ last_run_at: 'x' })).toBeNull();
    expect(parseMeta({ last_run_at: '2026-10-09T17:17:00Z', run_id: 'r', jobs: {} })).toBeNull();
  });

  it('parseMeta rebuilds boards and llm from validated entries only', () => {
    const hostile = JSON.parse(`{
      "last_run_at": "2026-10-09T17:17:00Z", "run_id": "r", "jobs": {"open": 1, "new": 1, "closed": 0},
      "boards": {
        "greenhouse": {"polled": 10, "ok": 9, "failed": 1, "extra": "x", "toString": "y"},
        "__proto__": {"polled": 1, "ok": 1, "failed": 0},
        "bad name!": {"polled": 1, "ok": 1, "failed": 0},
        "nan": {"polled": 1, "ok": 1, "failed": "1"},
        "inf": {"polled": 1, "ok": 1, "failed": 1e999}
      },
      "llm": [{"requests": 1, "tokens": 1}]
    }`) as unknown;
    const meta = parseMeta(hostile);
    expect(meta?.boards).toEqual({ greenhouse: { polled: 10, ok: 9, failed: 1 } });
    expect(Object.keys(meta?.boards ?? {})).toEqual(['greenhouse']);
    expect(Object.getPrototypeOf(meta?.boards)).toBe(Object.prototype);
    expect(meta?.llm).toEqual({});
    expect(meta?.boards).not.toBe((hostile as Record<string, unknown>).boards);
  });
});

describe('loaders', () => {
  it('loadIndexFile fetches the right path and parses', async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ generated_at: '2026-10-09T17:17:00Z', rows: [row] }), { status: 200 });
    }) as unknown as typeof fetch;
    const f = await loadIndexFile('7d', fetchFn);
    expect(calls).toEqual(['/data/index/7d.json']);
    expect(f.rows).toHaveLength(1);
  });

  it('loadIndexFile throws on HTTP errors', async () => {
    const fetchFn = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    await expect(loadIndexFile('latest', fetchFn)).rejects.toThrow('HTTP 503');
  });
});

describe('logoUrl and labels', () => {
  it('returns null without a client id or with a bad domain', () => {
    // Called with no explicit id under plain Node: must read the env lazily and not throw.
    expect(() => logoUrl('example.com')).not.toThrow();
    expect(logoUrl('example.com', undefined)).toBeNull();
    expect(logoUrl('example.com', '')).toBeNull();
    expect(logoUrl('not a domain', 'abcd1234')).toBeNull();
    expect(logoUrl('example.com', 'bad id!')).toBeNull();
  });

  it('builds the Brandfetch URL with the client id', () => {
    expect(logoUrl('Example.com', 'abcd1234')).toBe('https://cdn.brandfetch.io/example.com?c=abcd1234');
  });

  it('locationLabel falls back sensibly', () => {
    expect(locationLabel(row)).toBe('Littleton, CO');
    expect(locationLabel({ city: null, state: 'TX', arrangement: 'hybrid' })).toBe('TX');
    expect(locationLabel({ city: null, state: null, arrangement: 'remote' })).toBe('Remote (US)');
    expect(locationLabel({ city: null, state: null, arrangement: 'unknown' })).toBe('United States');
  });
});
