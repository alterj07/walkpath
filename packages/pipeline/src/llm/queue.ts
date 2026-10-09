import type { JobSummary } from '../schema/job.ts';
import type { StateDb } from '../state/db.ts';
import type { Summarizer, SummarizeJob } from './chain.ts';
import type { SummaryOutput } from './schema.ts';

export const DEFAULT_PER_RUN_CAP = 1_500;
export const DEFAULT_MAX_ATTEMPTS = 5;

export interface DrainOptions {
  db: StateDb;
  summarizer: Summarizer;
  /** Load the job to summarize; null when it no longer exists (the queue entry is dropped). */
  loadJob: (jobId: string) => SummarizeJob | null | Promise<SummarizeJob | null>;
  saveSummary: (jobId: string, summary: JobSummary, output: SummaryOutput) => void | Promise<void>;
  perRunCap?: number;
  maxAttempts?: number;
  /** Absolute wall-clock deadline (ms since epoch); the loop stops before starting a job past it. */
  deadlineMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export interface DrainResult {
  attempted: number;
  succeeded: number;
  invalid: number;
  dropped: number;
  /** True when the loop stopped because no provider could take a request. */
  exhausted: boolean;
  /** True when the loop stopped at the deadline. */
  timedOut: boolean;
  remaining: number;
}

export function toJobSummary(output: SummaryOutput, model: string, generatedAt: string): JobSummary {
  return {
    text: output.summary,
    responsibilities: output.responsibilities,
    qualifications: output.qualifications,
    must_have_skills: output.must_have_skills,
    nice_to_have_skills: output.nice_to_have_skills,
    model,
    generated_at: generatedAt,
  };
}

/**
 * Drain `summaries_pending` oldest-first (plan 4.8). Jobs stay queued when every
 * provider is exhausted so the site never waits on the LLM; invalid outputs are
 * retried on later runs up to `maxAttempts`.
 */
export async function drainSummaryQueue(opts: DrainOptions): Promise<DrainResult> {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const cap = opts.perRunCap ?? DEFAULT_PER_RUN_CAP;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const result: DrainResult = {
    attempted: 0,
    succeeded: 0,
    invalid: 0,
    dropped: 0,
    exhausted: false,
    timedOut: false,
    remaining: 0,
  };

  const pending = opts.db.dequeueSummaries(cap);
  for (const row of pending) {
    if (opts.deadlineMs !== undefined && now() >= opts.deadlineMs) {
      result.timedOut = true;
      break;
    }
    const job = await opts.loadJob(row.job_id);
    if (job === null) {
      opts.db.removeSummary(row.job_id);
      result.dropped += 1;
      continue;
    }
    result.attempted += 1;
    const outcome = await opts.summarizer.summarize(job);
    if (outcome.ok) {
      const summary = toJobSummary(outcome.output, `${outcome.provider}/${outcome.model}`, new Date(now()).toISOString());
      await opts.saveSummary(row.job_id, summary, outcome.output);
      opts.db.removeSummary(row.job_id);
      result.succeeded += 1;
      continue;
    }
    if (outcome.reason === 'exhausted') {
      result.exhausted = true;
      // No provider took the request, so this job was not really attempted; it stays queued untouched.
      result.attempted -= 1;
      log('llm: every provider exhausted or cooling down; leaving the rest queued');
      break;
    }
    result.invalid += 1;
    if (row.attempts + 1 >= maxAttempts) {
      opts.db.removeSummary(row.job_id);
      result.dropped += 1;
      log(`llm: dropping ${row.job_id} after ${maxAttempts} invalid attempts`);
    } else {
      opts.db.bumpAttempts(row.job_id);
    }
  }

  result.remaining = opts.db.countPendingSummaries();
  return result;
}
