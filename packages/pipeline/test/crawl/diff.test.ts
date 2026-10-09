import { describe, expect, it } from 'vitest';
import { HttpError } from '../../src/http/client.ts';
import { closeStale, diffBoard, pruneClosed } from '../../src/crawl/diff.ts';
import { openState } from '../../src/state/db.ts';
import { board, clock, fakeAdapter, makeHttp, type FakeBoardScript } from './fake-adapter.ts';

const job = (id: string, extra: Partial<FakeBoardScript['jobs'][number]> = {}) => ({
  id,
  title: `Software Engineering Intern ${id}`,
  description: `<p>Role ${id}</p>`,
  postedAt: '2026-10-09T08:00:00.000Z',
  ...extra,
});

function setup(script: FakeBoardScript, withDetail = false) {
  const scripts: Record<string, FakeBoardScript> = { acme: script };
  const { adapter, calls } = fakeAdapter(scripts, withDetail);
  const db = openState(':memory:');
  const c = clock();
  const run = () => diffBoard({ board: board(), adapter, http: makeHttp(), db, now: c.now });
  return { scripts, adapter, calls, db, c, run };
}

describe('diffBoard', () => {
  it('inserts every job as new on the first run and stamps first_seen_at', async () => {
    const { db, run, c } = setup({ jobs: [job('1'), job('2')] });
    const d = await run();
    expect(d.ok).toBe(true);
    expect(d.counts).toMatchObject({ listed: 2, new: 2, changed: 0, closed: 0 });
    expect(d.new.map((e) => e.kind)).toEqual(['new', 'new']);
    expect(d.new[0]?.first_seen_at).toBe(c.iso());
    expect(d.new[0]?.posted_at).toBe('2026-10-09T08:00:00.000Z');
    expect(d.new[0]?.posted_at_source).toBe('ATS_FIELD');
    expect(d.new[0]?.job_id).toMatch(/^[a-f0-9]{12}$/);
    expect(db.getJobsForBoard('greenhouse:acme')).toHaveLength(2);
    expect(db.getBoardState('greenhouse:acme')).toMatchObject({ job_count_last: 2, consecutive_failures: 0, last_success_at: c.iso() });
  });

  it('reports unchanged on an identical second run and bumps last_seen_at only', async () => {
    const { db, run, c } = setup({ jobs: [job('1'), job('2')] });
    await run();
    c.advanceHours(1);
    const d = await run();
    expect(d.counts).toMatchObject({ new: 0, changed: 0, unchanged: 2, closed: 0 });
    expect(d.new).toEqual([]);
    const row = db.getJob('greenhouse:acme:1');
    expect(row?.last_seen_at).toBe(c.iso());
    expect(row?.first_seen_at).not.toBe(c.iso());
  });

  it('classifies a changed description as changed without a new event', async () => {
    const { scripts, run, db } = setup({ jobs: [job('1')] });
    await run();
    const before = db.getJob('greenhouse:acme:1')!;
    scripts.acme!.jobs = [job('1', { description: '<p>edited</p>' })];
    const d = await run();
    expect(d.counts).toMatchObject({ new: 0, changed: 1 });
    expect(d.changed[0]?.kind).toBe('changed');
    expect(d.changed[0]?.job_id).toBe(before.job_id);
    expect(d.changed[0]?.first_seen_at).toBe(before.first_seen_at);
    expect(db.getJob('greenhouse:acme:1')?.content_hash).not.toBe(before.content_hash);
  });

  it('closes a job that disappears from a full successful fetch', async () => {
    const { scripts, run, db, c } = setup({ jobs: [job('1'), job('2'), job('3')] });
    await run();
    c.advanceHours(1);
    scripts.acme!.jobs = [job('1'), job('2')];
    const d = await run();
    expect(d.partial).toBe(false);
    expect(d.closed).toEqual(['greenhouse:acme:3']);
    expect(db.getJob('greenhouse:acme:3')?.closed_at).toBe(c.iso());
    expect(db.getBoardState('greenhouse:acme')?.job_count_last).toBe(2);
  });

  it('withholds closures when more than half the board vanishes (50% guard)', async () => {
    const { scripts, run, db } = setup({ jobs: [job('1'), job('2'), job('3'), job('4')] });
    await run();
    scripts.acme!.jobs = [job('1')];
    const d = await run();
    expect(d.ok).toBe(true);
    expect(d.partial).toBe(true);
    expect(d.closed).toEqual([]);
    expect(d.counts.missing).toBe(3);
    expect(db.getJob('greenhouse:acme:4')?.closed_at).toBeNull();
    // job_count_last is kept from the last trusted fetch.
    expect(db.getBoardState('greenhouse:acme')?.job_count_last).toBe(4);
  });

  it('treats an empty response as partial when the board had jobs', async () => {
    const { scripts, run } = setup({ jobs: [job('1')] });
    await run();
    scripts.acme!.jobs = [];
    const d = await run();
    expect(d.partial).toBe(true);
    expect(d.closed).toEqual([]);
  });

  it('never closes on a failed fetch and counts consecutive failures', async () => {
    const { scripts, run, db, c } = setup({ jobs: [job('1')] });
    await run();
    c.advanceHours(1);
    scripts.acme!.fail = new HttpError('http_status', 'boards-api.greenhouse.io', 503);
    const d = await run();
    expect(d.ok).toBe(false);
    expect(d.error).toBe('http_status');
    expect(d.closed).toEqual([]);
    expect(db.getJob('greenhouse:acme:1')?.closed_at).toBeNull();
    expect(db.getBoardState('greenhouse:acme')).toMatchObject({ consecutive_failures: 1, last_polled_at: c.iso() });
    scripts.acme!.fail = new Error('socket hang up');
    const d2 = await run();
    expect(d2.error).toBe('error');
    expect(db.getBoardState('greenhouse:acme')?.consecutive_failures).toBe(2);
    scripts.acme!.fail = null;
    await run();
    expect(db.getBoardState('greenhouse:acme')?.consecutive_failures).toBe(0);
  });

  it('reopens a closed job that reappears, keeping posted_at and first_seen_at', async () => {
    const { scripts, run, db, c } = setup({ jobs: [job('1'), job('2')] });
    await run();
    const original = db.getJob('greenhouse:acme:2')!;
    scripts.acme!.jobs = [job('1')];
    await run();
    expect(db.getJob('greenhouse:acme:2')?.closed_at).not.toBeNull();
    c.advanceDays(2);
    scripts.acme!.jobs = [job('1'), job('2')];
    const d = await run();
    expect(d.reopened).toEqual(['greenhouse:acme:2']);
    expect(d.counts.new).toBe(0);
    expect(d.changed.map((e) => e.canonical_key)).toEqual(['greenhouse:acme:2']);
    const row = db.getJob('greenhouse:acme:2')!;
    expect(row.closed_at).toBeNull();
    expect(row.posted_at).toBe(original.posted_at);
    expect(row.first_seen_at).toBe(original.first_seen_at);
  });

  it('treats a new id with the same requisition and title as a repost inheriting posted_at', async () => {
    const { scripts, run, db, c } = setup({ jobs: [job('1', { reqId: 'REQ-9', title: 'Flight Software Intern' })] });
    await run();
    const original = db.getJob('greenhouse:acme:1')!;
    c.advanceDays(10);
    scripts.acme!.jobs = [job('77', { reqId: 'REQ-9', title: '  flight   software intern ', postedAt: c.iso() })];
    const d = await run();
    expect(d.new).toEqual([]);
    expect(d.reposts).toHaveLength(1);
    expect(d.reposts[0]?.kind).toBe('repost');
    expect(d.reposts[0]?.posted_at).toBe(original.posted_at);
    expect(d.reposts[0]?.first_seen_at).toBe(original.first_seen_at);
    expect(d.closed).toEqual([]); // 1 of 1 missing trips the 50% guard
    const repost = db.getJob('greenhouse:acme:77')!;
    expect(repost.first_seen_at).toBe(original.first_seen_at);
  });

  it('clamps an ATS posted_at later than first_seen_at and marks the source FIRST_SEEN', async () => {
    const { run, c } = setup({ jobs: [job('1', { postedAt: '2026-10-09T15:00:00.000Z' })] });
    const d = await run();
    expect(d.new[0]?.posted_at).toBe(c.iso());
    expect(d.new[0]?.posted_at_source).toBe('FIRST_SEEN');
  });

  it('switches a FIRST_SEEN row to ATS_FIELD when the ATS later supplies an earlier timestamp', async () => {
    const { scripts, run, db } = setup({ jobs: [job('1', { postedAt: null })] });
    await run();
    expect(db.getJob('greenhouse:acme:1')?.posted_at_source).toBe('FIRST_SEEN');
    scripts.acme!.jobs = [job('1', { postedAt: '2026-10-08T06:00:00.000Z', description: '<p>edit</p>' })];
    const d = await run();
    expect(d.changed[0]?.posted_at).toBe('2026-10-08T06:00:00.000Z');
    expect(d.changed[0]?.posted_at_source).toBe('ATS_FIELD');
    expect(db.getJob('greenhouse:acme:1')?.posted_at_source).toBe('ATS_FIELD');
  });

  it('fails the board without closures when toInput throws on one job', async () => {
    const { scripts, run, db, c } = setup({ jobs: [job('1'), job('2')] });
    await run();
    c.advanceHours(1);
    scripts.acme!.jobs = [job('1'), job('2'), job('3')];
    scripts.acme!.badIds = ['2'];
    const d = await run();
    expect(d.ok).toBe(false);
    expect(d.error).toBe('invalid_job');
    expect(d.new).toEqual([]);
    expect(d.closed).toEqual([]);
    expect(d.consecutive_failures).toBe(1);
    expect(db.getJob('greenhouse:acme:3')).toBeNull();
    expect(db.getJob('greenhouse:acme:1')?.last_seen_at).not.toBe(c.iso());
    expect(db.getBoardState('greenhouse:acme')).toMatchObject({ consecutive_failures: 1, last_polled_at: c.iso(), job_count_last: 2 });
  });

  it('fails the board with state_error on a job_id collision instead of throwing', async () => {
    const { run, db } = setup({ jobs: [job('1')] });
    // Pre-seed a row for another board that already owns the job_id the new key hashes to.
    const { jobIdFromKey } = await import('../../src/ids.ts');
    db.upsertJobs([
      {
        canonical_key: 'greenhouse:other:9',
        job_id: jobIdFromKey('greenhouse:acme:1'),
        internal_req_id: null,
        content_hash: 'b'.repeat(32),
        posted_at: null,
        posted_at_source: null,
        first_seen_at: '2026-10-01T00:00:00.000Z',
        last_seen_at: '2026-10-01T00:00:00.000Z',
        closed_at: null,
        gate: null,
        gate_source: null,
        board_id: 'greenhouse:other',
        title: 'x',
        apply_url: null,
      },
    ]);
    const d = await run();
    expect(d.ok).toBe(false);
    expect(d.error).toBe('state_error');
    expect(db.getJob('greenhouse:acme:1')).toBeNull();
    expect(db.getBoardState('greenhouse:acme')?.consecutive_failures).toBe(1);
  });

  it('accepts a small board shrinking after three consecutive partial fetches (1 → 0)', async () => {
    const { scripts, run, db, c } = setup({ jobs: [job('1')] });
    await run();
    scripts.acme!.jobs = [];
    for (let i = 0; i < 2; i += 1) {
      c.advanceHours(1);
      const d = await run();
      expect(d.partial).toBe(true);
      expect(d.closed).toEqual([]);
      expect(db.getBoardState('greenhouse:acme')?.partial_streak).toBe(i + 1);
    }
    c.advanceHours(1);
    const d = await run();
    expect(d.partial).toBe(false);
    expect(d.closed).toEqual(['greenhouse:acme:1']);
    expect(db.getBoardState('greenhouse:acme')).toMatchObject({ partial_streak: 0, job_count_last: 0 });
    // A healthy fetch in between resets the streak (3 → 1 is partial; back to 3 is not).
    scripts.acme!.jobs = [job('1'), job('2'), job('3')];
    await run();
    scripts.acme!.jobs = [job('1')];
    await run();
    expect(db.getBoardState('greenhouse:acme')?.partial_streak).toBe(1);
    scripts.acme!.jobs = [job('1'), job('2'), job('3')];
    await run();
    expect(db.getBoardState('greenhouse:acme')?.partial_streak).toBe(0);
  });

  it('caps the description carried in the event at 64 KB', async () => {
    const { run } = setup({ jobs: [job('1', { description: 'x'.repeat(70 * 1024) })] });
    const d = await run();
    expect(d.new[0]?.input.descriptionHtml).toHaveLength(64 * 1024);
  });

  it('falls back to first_seen_at when the ATS has no timestamp', async () => {
    const { run, c } = setup({ jobs: [job('1', { postedAt: null })] });
    const d = await run();
    expect(d.new[0]?.posted_at).toBe(c.iso());
    expect(d.new[0]?.posted_at_source).toBe('FIRST_SEEN');
  });

  it('ignores duplicate ids within one response', async () => {
    const { run } = setup({ jobs: [job('1'), job('1')] });
    const d = await run();
    expect(d.counts.listed).toBe(1);
    expect(d.new).toHaveLength(1);
  });

  describe('detail adapters', () => {
    it('fetches detail only for new keys and keys whose light fields or version changed', async () => {
      const { scripts, calls, run, db } = setup({ jobs: [job('1', { updated_at: 'v1' }), job('2', { updated_at: 'v1' })] }, true);
      const d1 = await run();
      expect(calls.detail).toBe(2);
      expect(d1.counts.detail_fetched).toBe(2);
      expect(d1.new[0]?.input.descriptionHtml).toBe('<p>Role 1</p>');
      const d2 = await run();
      expect(calls.detail).toBe(2);
      expect(d2.counts.unchanged).toBe(2);
      // Description-only edit bumps updated_at → one detail fetch → changed.
      scripts.acme!.jobs = [job('1', { updated_at: 'v2', description: '<p>new text</p>' }), job('2', { updated_at: 'v1' })];
      const d3 = await run();
      expect(calls.detail).toBe(3);
      expect(calls.detailIds.at(-1)).toBe('1');
      expect(d3.changed.map((e) => e.canonical_key)).toEqual(['greenhouse:acme:1']);
      expect(d3.changed[0]?.input.descriptionHtml).toBe('<p>new text</p>');
      // Title edit without updated_at change still triggers detail.
      scripts.acme!.jobs = [job('1', { updated_at: 'v2', description: '<p>new text</p>' }), job('2', { updated_at: 'v1', title: 'Renamed Intern' })];
      const d4 = await run();
      expect(calls.detail).toBe(4);
      expect(d4.changed.map((e) => e.canonical_key)).toEqual(['greenhouse:acme:2']);
      expect(db.getJob('greenhouse:acme:2')?.title).toBe('Renamed Intern');
    });

    it('defers detail fetches above the per-board cap and picks them up next run', async () => {
      const jobs = Array.from({ length: 5 }, (_, i) => job(String(i + 1)));
      const scripts: Record<string, FakeBoardScript> = { acme: { jobs } };
      const { adapter, calls } = fakeAdapter(scripts, true);
      const db = openState(':memory:');
      const c = clock();
      const run = () => diffBoard({ board: board(), adapter, http: makeHttp(), db, now: c.now, detailCap: 3 });
      const d1 = await run();
      expect(calls.detail).toBe(3);
      expect(d1.new).toHaveLength(3);
      expect(d1.counts.detail_deferred).toBe(2);
      expect(db.getJobsForBoard('greenhouse:acme')).toHaveLength(3);
      const d2 = await run();
      expect(calls.detail).toBe(5);
      expect(d2.new).toHaveLength(2);
      expect(d2.counts.detail_deferred).toBe(0);
      expect(d2.closed).toEqual([]);
    });

    it('a failed detail fetch is neither a change nor a closure', async () => {
      const { scripts, run, db } = setup({ jobs: [job('1')] }, true);
      await run();
      scripts.acme!.jobs = [job('1', { title: 'Edited Intern' })];
      scripts.acme!.detailFail = true;
      const d = await run();
      expect(d.ok).toBe(true);
      expect(d.changed).toEqual([]);
      expect(d.closed).toEqual([]);
      expect(db.getJob('greenhouse:acme:1')?.title).toBe('Software Engineering Intern 1');
      expect(db.getJob('greenhouse:acme:1')?.closed_at).toBeNull();
      scripts.acme!.detailFail = false;
      const d2 = await run();
      expect(d2.changed).toHaveLength(1);
    });

    it('reopens a closed job on a detail adapter even when its light fields did not change', async () => {
      const { scripts, run, db, calls } = setup({ jobs: [job('1'), job('2'), job('3')] }, true);
      await run();
      scripts.acme!.jobs = [job('1'), job('2')];
      await run();
      expect(db.getJob('greenhouse:acme:3')?.closed_at).not.toBeNull();
      const before = calls.detail;
      scripts.acme!.jobs = [job('1'), job('2'), job('3')];
      const d = await run();
      expect(d.reopened).toEqual(['greenhouse:acme:3']);
      expect(calls.detail).toBe(before + 1);
      expect(db.getJob('greenhouse:acme:3')?.closed_at).toBeNull();
    });
  });
});

describe('closeStale and pruneClosed', () => {
  it('closes rows unseen for 45 days and prunes rows closed for 90 days', async () => {
    const { run, db, c } = setup({ jobs: [job('1')] });
    await run();
    c.advanceDays(44);
    expect(closeStale(db, c.now())).toEqual([]);
    c.advanceDays(2);
    expect(closeStale(db, c.now())).toEqual(['greenhouse:acme:1']);
    expect(db.getJob('greenhouse:acme:1')?.closed_at).toBe(c.iso());
    c.advanceDays(89);
    expect(pruneClosed(db, c.now())).toBe(0);
    c.advanceDays(2);
    expect(pruneClosed(db, c.now())).toBe(1);
    expect(db.getJob('greenhouse:acme:1')).toBeNull();
  });
});
