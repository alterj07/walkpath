import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpError } from '../../src/http/client.ts';
import { crawlBoards, readDiffArtifact, selectBoards, writeDiffArtifact } from '../../src/crawl/run.ts';
import { openState } from '../../src/state/db.ts';
import { board, clock, fakeAdapter, makeHttp, type FakeBoardScript } from './fake-adapter.ts';

const job = (id: string) => ({ id, title: `Data Science Intern ${id}`, description: `<p>${id}</p>`, postedAt: '2026-10-09T08:00:00.000Z' });

describe('crawlBoards', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it('skips disabled sources and inactive boards, aggregates per-ATS counts and failures', async () => {
    const scripts: Record<string, FakeBoardScript> = {
      acme: { jobs: [job('1'), job('2')] },
      globex: { jobs: [job('3')], fail: new HttpError('retry_exhausted', 'boards-api.greenhouse.io', 429) },
    };
    const { adapter, calls } = fakeAdapter(scripts);
    const db = openState(':memory:');
    const c = clock();
    const boards = [
      board({ board_key: 'acme' }),
      board({ board_key: 'globex', company_slug: 'globex' }),
      board({ board_key: 'initech', company_slug: 'initech', status: 'disabled' }),
      board({ board_key: 'lever-co', company_slug: 'lever-co', ats: 'lever' }),
    ];
    const report = await crawlBoards({
      boards,
      adapters: { greenhouse: adapter, lever: adapter },
      http: makeHttp(),
      db,
      now: c.now,
      concurrency: 2,
      sources: { lever: { enabled: false } },
      runId: 'crawl-test-1',
    });
    expect(calls.list).toBe(2);
    expect(report.run_id).toBe('crawl-test-1');
    expect(report.boards).toEqual({ polled: 2, ok: 1, failed: 1, partial: 0, skipped: 2, skipped_deadline: 0 });
    expect(report.per_ats['greenhouse']).toEqual({
      polled: 2,
      ok: 1,
      failed: 1,
      partial: 0,
      skipped: 1,
      skipped_deadline: 0,
      jobs: { new: 2, changed: 0, closed: 0, reopened: 0, reposts: 0 },
    });
    expect(report.per_ats['lever']?.skipped).toBe(1);
    expect(report.jobs).toEqual({ new: 2, changed: 0, closed: 0, reopened: 0, reposts: 0 });
    expect(report.events.map((e) => e.canonical_key)).toEqual(['greenhouse:acme:1', 'greenhouse:acme:2']);
    expect(report.failures).toEqual([{ board_id: 'greenhouse:globex', code: 'retry_exhausted' }]);
    expect(report.needs_refingerprint).toEqual([]);
    expect(db.recentRuns(1)[0]).toMatchObject({ run_id: 'crawl-test-1', kind: 'crawl', finished_at: c.iso() });
  });

  it('stops starting boards once shouldStop fires and counts the rest as skipped_deadline', async () => {
    const scripts: Record<string, FakeBoardScript> = {
      a: { jobs: [job('1')] },
      b: { jobs: [job('2')] },
      c: { jobs: [job('3')] },
    };
    const { adapter, calls } = fakeAdapter(scripts);
    const db = openState(':memory:');
    let started = 0;
    const report = await crawlBoards({
      boards: [board({ board_key: 'a' }), board({ board_key: 'b', company_slug: 'b' }), board({ board_key: 'c', company_slug: 'c' })],
      adapters: { greenhouse: adapter },
      http: makeHttp(),
      db,
      now: clock().now,
      concurrency: 1,
      // Fires after the first board has been taken.
      shouldStop: () => started++ >= 1,
    });
    expect(calls.list).toBe(1);
    expect(report.boards).toMatchObject({ polled: 1, ok: 1, failed: 0, skipped_deadline: 2 });
    expect(report.per_ats['greenhouse']?.skipped_deadline).toBe(2);
    expect(report.failures).toEqual([]);
    expect(report.events.map((e) => e.canonical_key)).toEqual(['greenhouse:a:1']);
  });

  it('forceRefresh re-emits unchanged jobs as changed (backfill mode)', async () => {
    const scripts: Record<string, FakeBoardScript> = { a: { jobs: [job('1'), job('2')] } };
    const { adapter } = fakeAdapter(scripts);
    const db = openState(':memory:');
    const c = clock();
    const opts = { boards: [board({ board_key: 'a' })], adapters: { greenhouse: adapter }, http: makeHttp(), db, now: c.now };
    const first = await crawlBoards(opts);
    expect(first.jobs.new).toBe(2);
    const second = await crawlBoards(opts);
    expect(second.jobs).toMatchObject({ new: 0, changed: 0 });
    const third = await crawlBoards({ ...opts, forceRefresh: true });
    expect(third.jobs).toMatchObject({ new: 0, changed: 2, closed: 0 });
    expect(third.events.every((e) => e.kind === 'changed')).toBe(true);
  });

  it('turns an adapter that throws outside listJobs into a failed board and still writes the artifact', async () => {
    const scripts: Record<string, FakeBoardScript> = { acme: { jobs: [job('1')] }, globex: { jobs: [job('2')] } };
    const { adapter } = fakeAdapter(scripts);
    const throwing = { ...adapter, canonicalKey: () => { throw new TypeError('bad raw'); } };
    const db = openState(':memory:');
    const report = await crawlBoards({
      boards: [board(), board({ board_key: 'globex', company_slug: 'globex' })],
      adapters: { greenhouse: throwing },
      http: makeHttp(),
      db,
    });
    expect(report.boards).toMatchObject({ polled: 2, ok: 0, failed: 2 });
    expect(report.failures.map((f) => f.code)).toEqual(['invalid_job', 'invalid_job']);
    expect(db.getBoardState('greenhouse:acme')?.consecutive_failures).toBe(1);
    const dir = await mkdtemp(join(tmpdir(), 'walkpath-diff-'));
    dirs.push(dir);
    await writeDiffArtifact(report, join(dir, 'diff.json'));
    expect((await readDiffArtifact(join(dir, 'diff.json'))).failures).toHaveLength(2);
  });

  it('flags boards that failed three runs in a row', async () => {
    const scripts: Record<string, FakeBoardScript> = {
      acme: { jobs: [], fail: new HttpError('http_status', 'boards-api.greenhouse.io', 404) },
    };
    const { adapter } = fakeAdapter(scripts);
    const db = openState(':memory:');
    const args = { boards: [board()], adapters: { greenhouse: adapter }, http: makeHttp(), db };
    await crawlBoards(args);
    await crawlBoards(args);
    expect((await crawlBoards(args)).needs_refingerprint).toEqual(['greenhouse:acme']);
  });

  it('round-trips the diff artifact through JSON with schema validation', async () => {
    const scripts: Record<string, FakeBoardScript> = { acme: { jobs: [job('1')] } };
    const { adapter } = fakeAdapter(scripts);
    const db = openState(':memory:');
    const report = await crawlBoards({ boards: [board()], adapters: { greenhouse: adapter }, http: makeHttp(), db });
    const dir = await mkdtemp(join(tmpdir(), 'walkpath-diff-'));
    dirs.push(dir);
    const path = join(dir, 'diff-api.json');
    await writeDiffArtifact(report, path);
    const back = await readDiffArtifact(path);
    expect(back).toEqual(report);
    expect(back.events[0]?.input.title).toBe('Data Science Intern 1');
    expect(report.run_id).toMatch(/^crawl-\d{8}T\d{6}-[a-f0-9]{6}$/);
  });

  it('selectBoards leaves out boards without an adapter', () => {
    const { selected, skipped } = selectBoards([board(), board({ ats: 'workday', board_key: 'acme/Ext', wd: 5 })], {
      greenhouse: fakeAdapter({}).adapter,
    });
    expect(selected.map((s) => s.board.ats)).toEqual(['greenhouse']);
    expect(selected[0]?.adapter.source).toBe('greenhouse');
    expect(skipped.map((b) => b.ats)).toEqual(['workday']);
  });
});
