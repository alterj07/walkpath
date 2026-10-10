import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpClient, HttpError } from '../../src/http/client.ts';
import { HostLimiter, LimiterAbortError } from '../../src/http/limiter.ts';
import { crawlBoards, writeDiffArtifact } from '../../src/crawl/run.ts';
import { openState } from '../../src/state/db.ts';
import { board, fakeAdapter } from './fake-adapter.ts';

const never = () => new Promise<Response>(() => {});

describe('hard deadline (abort signal)', () => {
  it('aborts a request that is waiting for a host slot', async () => {
    const limiter = new HostLimiter();
    const release = await limiter.acquire('h', { minDelayMs: 0, maxConcurrency: 1 });
    const ac = new AbortController();
    const waiting = limiter.acquire('h', { minDelayMs: 0, maxConcurrency: 1 }, ac.signal);
    ac.abort();
    await expect(waiting).rejects.toBeInstanceOf(LimiterAbortError);
    release();
    // The slot is free again for a later caller.
    const again = await limiter.acquire('h', { minDelayMs: 0, maxConcurrency: 1 });
    again();
  });

  it('aborts an in-flight fetch with HttpError aborted and never retries it', async () => {
    const ac = new AbortController();
    let calls = 0;
    const http = new HttpClient({ fetch: () => { calls += 1; return never(); }, respectRobots: false, signal: ac.signal, timeoutMs: 60_000 });
    const p = http.request({ url: 'https://boards-api.greenhouse.io/x', allowedHosts: ['boards-api.greenhouse.io'], limits: { minDelayMs: 0, maxConcurrency: 4 } });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
    expect(calls).toBe(1);
    // After the abort nothing new is sent.
    await expect(http.request({ url: 'https://boards-api.greenhouse.io/y', allowedHosts: ['boards-api.greenhouse.io'], limits: { minDelayMs: 0, maxConcurrency: 4 } })).rejects.toMatchObject({ code: 'aborted' });
    expect(calls).toBe(1);
  });

  it('ends the run within the grace, writes the artifact and closes nothing', async () => {
    const ac = new AbortController();
    const http = new HttpClient({ fetch: never, respectRobots: false, signal: ac.signal, timeoutMs: 60_000 });
    const db = openState(':memory:');
    const job = { id: '1', title: 'Data Science Intern', description: '<p>x</p>', postedAt: '2026-10-09T08:00:00.000Z' };
    const { adapter } = fakeAdapter({
      hang: { jobs: [job], viaHttp: 'https://boards-api.greenhouse.io/hang' },
      quick: { jobs: [job] },
    });
    // Pretend `hang` had a job before so a closure would be visible if the abort were mistaken for an empty list.
    db.upsertBoardState({ board_id: 'greenhouse:hang', last_polled_at: null, last_success_at: null, consecutive_failures: 2, job_count_last: 1, partial_streak: 0, etag: null, last_modified: null });
    const started = Date.now();
    setTimeout(() => ac.abort(), 50);
    const report = await crawlBoards({
      boards: [board({ board_key: 'hang' }), board({ board_key: 'quick', company_slug: 'quick' })],
      adapters: { greenhouse: adapter },
      http,
      db,
      signal: ac.signal,
      concurrency: 4,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(report.boards).toMatchObject({ ok: 1, failed: 0, skipped_deadline: 1, polled: 1 });
    expect(report.failures).toEqual([{ board_id: 'greenhouse:hang', code: 'aborted' }]);
    expect(report.closed_keys).toEqual([]);
    expect(db.getBoardState('greenhouse:hang')?.consecutive_failures).toBe(2);
    const dir = await mkdtemp(join(tmpdir(), 'wp-abort-'));
    try {
      const path = join(dir, 'diff.json');
      await writeDiffArtifact(report, path);
      expect((await stat(path)).size).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    db.close();
  });

  it('runs sources in their own pools so one slow host does not starve the others', async () => {
    const db = openState(':memory:');
    const job = { id: '1', title: 'Software Intern', description: '<p>x</p>', postedAt: '2026-10-09T08:00:00.000Z' };
    const { adapter: gh } = fakeAdapter({ g1: { jobs: [job] }, g2: { jobs: [job] }, g3: { jobs: [job] } });
    const { adapter: lv } = fakeAdapter({ l1: { jobs: [job] } });
    (lv as { source: string }).source = 'lever';
    const http = new HttpClient({ fetch: async () => new Response('{}'), respectRobots: false });
    const report = await crawlBoards({
      boards: [board({ board_key: 'g1' }), board({ board_key: 'g2', company_slug: 'g2' }), board({ board_key: 'g3', company_slug: 'g3' }), board({ board_key: 'l1', company_slug: 'l1', ats: 'lever' })],
      adapters: { greenhouse: gh, lever: lv },
      http,
      db,
      concurrency: 40,
    });
    expect(report.boards.ok).toBe(4);
    expect(report.per_ats['lever']?.ok).toBe(1);
    expect(report.per_ats['greenhouse']?.ok).toBe(3);
    db.close();
  });
});

describe('HttpError aborted code', () => {
  it('is a known code', () => {
    expect(new HttpError('aborted', 'h').code).toBe('aborted');
  });
});
