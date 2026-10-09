import { describe, expect, it } from 'vitest';
import type { Summarizer, SummarizeJob, SummarizeResult } from '../../src/llm/chain.ts';
import { drainSummaryQueue, toJobSummary } from '../../src/llm/queue.ts';
import type { JobSummary } from '../../src/schema/job.ts';
import { JobSummarySchema } from '../../src/schema/job.ts';
import { openState } from '../../src/state/db.ts';
import { GOOD_OUTPUT } from './fixtures.ts';
import { validateSummaryOutput } from '../../src/llm/schema.ts';

const output = (() => {
  const v = validateSummaryOutput(GOOD_OUTPUT);
  if (!v.ok) throw new Error('fixture invalid');
  return v.value;
})();

function fakeSummarizer(script: Array<'ok' | 'invalid' | 'exhausted'>): Summarizer & { seen: string[] } {
  const queue = [...script];
  const seen: string[] = [];
  return {
    seen,
    availableProviders: () => ['a'],
    async summarize(job: SummarizeJob): Promise<SummarizeResult> {
      seen.push(job.job_id);
      const step = queue.shift() ?? 'exhausted';
      if (step === 'ok') return { ok: true, output, provider: 'a', model: 'a-model' };
      return { ok: false, reason: step };
    },
  };
}

const ids = ['a1a1a1a1a1a1', 'b2b2b2b2b2b2', 'c3c3c3c3c3c3', 'd4d4d4d4d4d4'];
const loadJob = (id: string): SummarizeJob | null =>
  id === 'd4d4d4d4d4d4' ? null : { job_id: id, title: 't', company: 'c', location: 'l', descriptionHtml: '<p>x</p>' };

function seed() {
  const db = openState(':memory:');
  ids.forEach((id, i) => db.enqueueSummary(id, `2026-10-09T0${i}:00:00.000Z`));
  return db;
}

describe('drainSummaryQueue', () => {
  it('drains oldest first, saves summaries, drops vanished jobs and reports counts', async () => {
    const db = seed();
    const saved: Array<[string, JobSummary]> = [];
    const s = fakeSummarizer(['ok', 'ok', 'ok']);
    const r = await drainSummaryQueue({
      db,
      summarizer: s,
      loadJob,
      saveSummary: (id, summary) => void saved.push([id, summary]),
      now: () => Date.UTC(2026, 9, 9, 16, 0, 0),
    });
    expect(s.seen).toEqual(ids.slice(0, 3));
    expect(saved.map(([id]) => id)).toEqual(ids.slice(0, 3));
    expect(JobSummarySchema.safeParse(saved[0]?.[1]).success).toBe(true);
    expect(saved[0]?.[1].model).toBe('a/a-model');
    expect(saved[0]?.[1].generated_at).toBe('2026-10-09T16:00:00.000Z');
    expect(r).toEqual({ attempted: 3, succeeded: 3, invalid: 0, dropped: 1, exhausted: false, timedOut: false, remaining: 0 });
  });

  it('stops on exhausted and leaves the rest queued', async () => {
    const db = seed();
    const s = fakeSummarizer(['ok', 'exhausted']);
    const r = await drainSummaryQueue({ db, summarizer: s, loadJob, saveSummary: () => {} });
    expect(r.succeeded).toBe(1);
    expect(r.exhausted).toBe(true);
    expect(r.attempted).toBe(1);
    expect(r.remaining).toBe(3);
    expect(db.dequeueSummaries(10).map((row) => row.job_id)).toEqual(ids.slice(1));
  });

  it('bumps attempts on invalid and drops after maxAttempts', async () => {
    const db = seed();
    const s = fakeSummarizer(['invalid', 'invalid', 'invalid']);
    const r = await drainSummaryQueue({ db, summarizer: s, loadJob, saveSummary: () => {}, maxAttempts: 2, perRunCap: 3 });
    expect(r.invalid).toBe(3);
    expect(db.dequeueSummaries(10).map((row) => [row.job_id, row.attempts])).toEqual([
      ['a1a1a1a1a1a1', 1],
      ['b2b2b2b2b2b2', 1],
      ['c3c3c3c3c3c3', 1],
      ['d4d4d4d4d4d4', 0],
    ]);
    const r2 = await drainSummaryQueue({ db, summarizer: fakeSummarizer(['invalid', 'ok']), loadJob, saveSummary: () => {}, maxAttempts: 2, perRunCap: 2 });
    expect(r2.dropped).toBe(1);
    expect(r2.succeeded).toBe(1);
    expect(db.dequeueSummaries(10).map((row) => row.job_id)).toEqual(['c3c3c3c3c3c3', 'd4d4d4d4d4d4']);
  });

  it('respects the per-run cap and the deadline', async () => {
    const db = seed();
    const capped = await drainSummaryQueue({ db, summarizer: fakeSummarizer(['ok', 'ok']), loadJob, saveSummary: () => {}, perRunCap: 1 });
    expect(capped.succeeded).toBe(1);
    expect(capped.remaining).toBe(3);

    let t = 0;
    const timed = await drainSummaryQueue({
      db,
      summarizer: fakeSummarizer(['ok', 'ok', 'ok']),
      loadJob,
      saveSummary: () => {
        t += 1000;
      },
      deadlineMs: 1500,
      now: () => t,
    });
    expect(timed.succeeded).toBe(2);
    expect(timed.timedOut).toBe(true);
    expect(timed.remaining).toBe(1);
  });
});

describe('toJobSummary', () => {
  it('maps the model output onto the stored summary shape', () => {
    const s = toJobSummary(output, 'mistral/mistral-small-latest', '2026-10-09T00:00:00.000Z');
    expect(JobSummarySchema.parse(s)).toEqual({
      text: output.summary,
      responsibilities: output.responsibilities,
      qualifications: output.qualifications,
      must_have_skills: output.must_have_skills,
      nice_to_have_skills: output.nice_to_have_skills,
      model: 'mistral/mistral-small-latest',
      generated_at: '2026-10-09T00:00:00.000Z',
    });
  });
});
