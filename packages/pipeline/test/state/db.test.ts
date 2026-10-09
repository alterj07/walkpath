import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openState, type JobSeenRow } from '../../src/state/db.ts';

const row = (key: string, overrides: Partial<JobSeenRow> = {}): JobSeenRow => ({
  canonical_key: key,
  job_id: 'aaaaaaaaaaaa',
  internal_req_id: null,
  content_hash: 'a'.repeat(32),
  posted_at: '2026-10-01T00:00:00.000Z',
  posted_at_source: 'ATS_FIELD',
  first_seen_at: '2026-10-01T00:10:00.000Z',
  last_seen_at: '2026-10-01T00:10:00.000Z',
  closed_at: null,
  gate: null,
  gate_source: null,
  board_id: 'greenhouse:acme',
  title: 'Software Engineering Intern',
  apply_url: 'https://boards.greenhouse.io/acme/jobs/1',
  ...overrides,
});

describe('StateDb', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it('migrates idempotently when the same file is opened twice', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'walkpath-state-'));
    dirs.push(dir);
    const path = join(dir, 'state.sqlite');
    const a = openState(path);
    a.upsertBoardState({
      board_id: 'greenhouse:acme',
      last_polled_at: '2026-10-09T12:00:00.000Z',
      last_success_at: null,
      consecutive_failures: 1,
      job_count_last: null,
      partial_streak: 2,
      etag: null,
      last_modified: null,
    });
    a.close();
    const b = openState(path);
    expect(b.getBoardState('greenhouse:acme')).toMatchObject({ consecutive_failures: 1, partial_streak: 2 });
    b.close();
  });

  it('upserts and reads jobs, closes only open rows, reopens', () => {
    const db = openState(':memory:');
    db.upsertJobs([row('greenhouse:acme:1', { job_id: 'aaaaaaaaaaa1' }), row('greenhouse:acme:2', { job_id: 'aaaaaaaaaaa2' })]);
    expect(db.getJobsForBoard('greenhouse:acme')).toHaveLength(2);
    expect(db.getJob('greenhouse:acme:1')?.title).toBe('Software Engineering Intern');
    expect(db.getJobById('aaaaaaaaaaa2')?.canonical_key).toBe('greenhouse:acme:2');

    db.markClosed(['greenhouse:acme:1'], '2026-10-02T00:00:00.000Z');
    db.markClosed(['greenhouse:acme:1'], '2026-10-03T00:00:00.000Z'); // second close must not move closed_at
    expect(db.getJob('greenhouse:acme:1')?.closed_at).toBe('2026-10-02T00:00:00.000Z');
    expect(db.countOpenJobs()).toBe(1);

    db.reopen(['greenhouse:acme:1'], '2026-10-04T00:00:00.000Z');
    const reopened = db.getJob('greenhouse:acme:1');
    expect(reopened?.closed_at).toBeNull();
    expect(reopened?.last_seen_at).toBe('2026-10-04T00:00:00.000Z');
    expect(reopened?.posted_at).toBe('2026-10-01T00:00:00.000Z');

    db.upsertJobs([row('greenhouse:acme:1', { job_id: 'aaaaaaaaaaa1', title: 'Renamed' })]);
    expect(db.getJob('greenhouse:acme:1')?.title).toBe('Renamed');
    expect(db.getJobsForBoard('greenhouse:acme')).toHaveLength(2);
    db.close();
  });

  it('rolls back a transaction on error', () => {
    const db = openState(':memory:');
    expect(() =>
      db.withTransaction(() => {
        db.upsertJobs([row('greenhouse:acme:1', { job_id: 'aaaaaaaaaaa1' })]);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.getJob('greenhouse:acme:1')).toBeNull();
    // Nested transactions join the outer one.
    db.withTransaction(() => {
      db.withTransaction(() => db.upsertJobs([row('greenhouse:acme:2', { job_id: 'aaaaaaaaaaa2' })]));
    });
    expect(db.getJob('greenhouse:acme:2')).not.toBeNull();
    db.close();
  });

  it('closes stale rows and prunes long-closed rows', () => {
    const db = openState(':memory:');
    db.upsertJobs([
      row('greenhouse:acme:old', { job_id: 'aaaaaaaaaaa1', last_seen_at: '2026-08-01T00:00:00.000Z' }),
      row('greenhouse:acme:fresh', { job_id: 'aaaaaaaaaaa2', last_seen_at: '2026-10-08T00:00:00.000Z' }),
      row('greenhouse:acme:ancient', { job_id: 'aaaaaaaaaaa3', closed_at: '2026-06-01T00:00:00.000Z' }),
    ]);
    const closed = db.closeStaleBefore('2026-08-25T00:00:00.000Z', '2026-10-09T00:00:00.000Z');
    expect(closed).toEqual(['greenhouse:acme:old']);
    expect(db.getJob('greenhouse:acme:fresh')?.closed_at).toBeNull();
    expect(db.pruneClosedBefore('2026-07-11T00:00:00.000Z')).toBe(1);
    expect(db.getJob('greenhouse:acme:ancient')).toBeNull();
    expect(db.getJob('greenhouse:acme:old')).not.toBeNull();
    db.close();
  });

  it('queues summaries oldest first, bumps attempts, removes', () => {
    const db = openState(':memory:');
    db.enqueueSummary('bbbbbbbbbbb2', '2026-10-09T02:00:00.000Z');
    db.enqueueSummary('bbbbbbbbbbb1', '2026-10-09T01:00:00.000Z');
    db.enqueueSummary('bbbbbbbbbbb1', '2026-10-09T03:00:00.000Z'); // ignored duplicate
    expect(db.countPendingSummaries()).toBe(2);
    expect(db.dequeueSummaries(1).map((r) => r.job_id)).toEqual(['bbbbbbbbbbb1']);
    db.bumpAttempts('bbbbbbbbbbb1');
    expect(db.dequeueSummaries(5)[0]?.attempts).toBe(1);
    db.removeSummary('bbbbbbbbbbb1');
    expect(db.dequeueSummaries(5).map((r) => r.job_id)).toEqual(['bbbbbbbbbbb2']);
    db.close();
  });

  it('accumulates llm usage per day and provider', () => {
    const db = openState(':memory:');
    db.addLlmUsage('2026-10-09', 'mistral', 1, 2400);
    db.addLlmUsage('2026-10-09', 'mistral', 2, 4800);
    db.addLlmUsage('2026-10-09', 'gemini', 1, 2000);
    expect(db.getLlmUsage('2026-10-09')).toEqual([
      { day: '2026-10-09', provider: 'gemini', requests: 1, tokens: 2000 },
      { day: '2026-10-09', provider: 'mistral', requests: 3, tokens: 7200 },
    ]);
    expect(db.getLlmUsage('2026-10-08')).toEqual([]);
    db.close();
  });

  it('records runs', () => {
    const db = openState(':memory:');
    db.logRun({ run_id: 'r1', started_at: '2026-10-09T12:00:00.000Z', finished_at: null, kind: 'crawl', stats_json: null });
    db.logRun({ run_id: 'r1', started_at: '2026-10-09T12:00:00.000Z', finished_at: '2026-10-09T12:05:00.000Z', kind: 'crawl', stats_json: '{}' });
    expect(db.recentRuns(5)).toHaveLength(1);
    expect(db.recentRuns(5)[0]?.finished_at).toBe('2026-10-09T12:05:00.000Z');
    db.close();
  });
});
