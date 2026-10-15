import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fnv1a32, type Shard } from '../cli/shard.ts';
import { BucketFileSchema } from '../publish/formats.ts';
import { SUMMARIES_DIR, type SummaryFile } from '../publish/summary-files.ts';
import type { JobRecord } from '../schema/job.ts';
import type { Summarizer } from './chain.ts';
import { toJobSummary } from './queue.ts';

/**
 * Pure helpers behind `scripts/summarize-local.ts`: pick the records that still need a summary,
 * split them across runners, and write one `summaries/<id>.json` per job for the publish run to
 * fold in (`publish/summary-files.ts`).
 */

/** Records with no summary, oldest first, from `jobs/` and `pending/` bucket files. */
export async function listUnsummarized(dataDir: string): Promise<JobRecord[]> {
  const out: JobRecord[] = [];
  for (const sub of ['jobs', 'pending']) {
    const dir = join(dataDir, sub);
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      continue;
    }
    for (const name of names.sort()) {
      if (!/^[0-9a-f]{2}\.json$/.test(name)) continue;
      const parsed = BucketFileSchema.safeParse(JSON.parse(await readFile(join(dir, name), 'utf8')));
      if (!parsed.success) continue;
      for (const record of Object.values(parsed.data)) {
        if (record.summary === null && record.closed_at === null) out.push(record);
      }
    }
  }
  return out.sort((a, b) => (a.first_seen_at < b.first_seen_at ? -1 : a.first_seen_at > b.first_seen_at ? 1 : a.id < b.id ? -1 : 1));
}

/** Deterministic shard membership by job id, so parallel runners never summarize the same job. */
export function inJobShard(id: string, shard: Shard): boolean {
  if (shard.count === 1) return true;
  return fnv1a32(id) % shard.count === shard.index;
}

/** Ids that already have a summary file written (skipped on a re-run before publish folds them in). */
export async function existingSummaryIds(outDir: string): Promise<Set<string>> {
  try {
    const names = await readdir(join(outDir, SUMMARIES_DIR));
    return new Set(names.filter((n) => /^[0-9a-f]{12}\.json$/.test(n)).map((n) => n.slice(0, 12)));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return new Set();
  }
}

export function selectRecords(records: readonly JobRecord[], shard: Shard, done: ReadonlySet<string>, max: number): JobRecord[] {
  return records.filter((r) => inJobShard(r.id, shard) && !done.has(r.id)).slice(0, max);
}

export interface SummarizeRecordsOptions {
  records: readonly JobRecord[];
  summarizer: Summarizer;
  outDir: string;
  /** Absolute wall-clock deadline (ms since epoch). */
  deadlineMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export interface SummarizeRecordsResult {
  attempted: number;
  written: number;
  invalid: number;
  exhausted: boolean;
  timedOut: boolean;
  /** Milliseconds spent inside the model per written summary (for throughput logs). */
  avgMsPerSummary: number;
}

export async function summarizeRecords(opts: SummarizeRecordsOptions): Promise<SummarizeRecordsResult> {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const result: SummarizeRecordsResult = { attempted: 0, written: 0, invalid: 0, exhausted: false, timedOut: false, avgMsPerSummary: 0 };
  const dir = join(opts.outDir, SUMMARIES_DIR);
  await mkdir(dir, { recursive: true });
  let totalMs = 0;
  for (const record of opts.records) {
    if (opts.deadlineMs !== undefined && now() >= opts.deadlineMs) {
      result.timedOut = true;
      break;
    }
    const location = [record.location.city, record.location.state].filter(Boolean).join(', ') || record.location.raw;
    const started = now();
    result.attempted += 1;
    const outcome = await opts.summarizer.summarize({
      job_id: record.id,
      title: record.title_raw,
      company: record.company.name,
      location,
      descriptionHtml: record.description_html,
    });
    const elapsed = now() - started;
    if (!outcome.ok) {
      if (outcome.reason === 'exhausted') {
        result.exhausted = true;
        result.attempted -= 1;
        log('summarize: provider exhausted or unreachable; stopping');
        break;
      }
      result.invalid += 1;
      log(`summarize: invalid output for ${record.id} (${elapsed} ms)`);
      continue;
    }
    const generatedAt = new Date(now()).toISOString();
    const file: SummaryFile = {
      id: record.id,
      content_hash: record.content_hash,
      summary: toJobSummary(outcome.output, `${outcome.provider}/${outcome.model}`, generatedAt),
      output: outcome.output,
      generated_at: generatedAt,
    };
    await writeFile(join(dir, `${record.id}.json`), `${JSON.stringify(file, null, 2)}\n`);
    totalMs += elapsed;
    result.written += 1;
    log(`summarize: wrote ${record.id} in ${elapsed} ms`);
  }
  result.avgMsPerSummary = result.written > 0 ? Math.round(totalMs / result.written) : 0;
  return result;
}
