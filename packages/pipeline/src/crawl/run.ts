import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { SourceAdapter } from '../adapters/types.ts';
import type { HttpClient } from '../http/client.ts';
import { boardId as boardIdOf, type Board } from '../schema/board.ts';
import { AtsSchema, IsoDateTimeSchema, JobIdSchema, PostedAtSourceSchema, type Ats } from '../schema/common.ts';
import { JobPostingInputSchema } from '../schema/job.ts';
import type { StateDb } from '../state/db.ts';
import { diffBoard, type BoardDiff, type JobEvent } from './diff.ts';

/**
 * Runs diffBoard over a registry slice with a global concurrency cap and produces the
 * `diff-*.json` artifact the publish job consumes (plan 4.4). Per-host politeness lives
 * in HttpClient; this layer only bounds how many boards are in flight at once.
 */

/** Shape of `registry/sources.json`'s `sources` map; missing entries mean enabled. */
export type SourceToggles = Partial<Record<Ats, { enabled: boolean }>>;

export interface CrawlOptions {
  boards: readonly Board[];
  adapters: Partial<Record<Ats, SourceAdapter>>;
  http: HttpClient;
  db: StateDb;
  concurrency?: number;
  now?: () => Date;
  log?: (message: string) => void;
  sources?: SourceToggles;
  kind?: string;
  runId?: string;
  detailCap?: number;
}

const BoardCountsSchema = z.object({
  polled: z.number().int(),
  ok: z.number().int(),
  failed: z.number().int(),
  partial: z.number().int(),
  skipped: z.number().int(),
});

const JobCountsSchema = z.object({
  new: z.number().int(),
  changed: z.number().int(),
  closed: z.number().int(),
  reopened: z.number().int(),
  reposts: z.number().int(),
});

export const JobEventSchema = z.object({
  kind: z.enum(['new', 'changed', 'repost']),
  canonical_key: z.string().min(1),
  job_id: JobIdSchema,
  board_id: z.string().min(1),
  ats: AtsSchema,
  board_key: z.string().min(1),
  input: JobPostingInputSchema,
  posted_at: IsoDateTimeSchema,
  posted_at_source: PostedAtSourceSchema,
  first_seen_at: IsoDateTimeSchema,
  content_hash: z.string().regex(/^[a-f0-9]{32}$/),
  internal_req_id: z.string().nullable(),
});

/**
 * The diff artifact: uploaded by each crawl job and read by the publish job. Every event
 * embeds its (64 KB-capped) description, so a busy hour is tens of MB; the workflow must
 * set `retention-days: 1` on the artifact.
 */
export const CrawlReportSchema = z.object({
  run_id: z.string().min(1),
  kind: z.string().min(1),
  started_at: IsoDateTimeSchema,
  finished_at: IsoDateTimeSchema,
  boards: BoardCountsSchema,
  per_ats: z.record(z.string(), BoardCountsSchema.extend({ jobs: JobCountsSchema })),
  jobs: JobCountsSchema,
  events: z.array(JobEventSchema),
  closed_keys: z.array(z.string()),
  reopened_keys: z.array(z.string()),
  failures: z.array(z.object({ board_id: z.string(), code: z.string() })),
  needs_refingerprint: z.array(z.string()),
});
export type CrawlReport = z.infer<typeof CrawlReportSchema>;

type PerAts = CrawlReport['per_ats'][string];

const emptyPerAts = (): PerAts => ({
  polled: 0,
  ok: 0,
  failed: 0,
  partial: 0,
  skipped: 0,
  jobs: { new: 0, changed: 0, closed: 0, reopened: 0, reposts: 0 },
});

export function newRunId(kind: string, startedAt: Date): string {
  const stamp = startedAt.toISOString().replace(/[-:.]/g, '').slice(0, 15);
  return `${kind}-${stamp}-${randomBytes(3).toString('hex')}`;
}

export interface SelectedBoard {
  board: Board;
  adapter: SourceAdapter;
}

/** Boards actually polled this run: active, with an adapter, and an enabled source. */
export function selectBoards(
  boards: readonly Board[],
  adapters: Partial<Record<Ats, SourceAdapter>>,
  sources: SourceToggles = {},
): { selected: SelectedBoard[]; skipped: Board[] } {
  const selected: SelectedBoard[] = [];
  const skipped: Board[] = [];
  for (const b of boards) {
    const enabled = sources[b.ats]?.enabled ?? true;
    const adapter = adapters[b.ats];
    if (b.status !== 'active' || !enabled || adapter === undefined) skipped.push(b);
    else selected.push({ board: b, adapter });
  }
  return { selected, skipped };
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function crawlBoards(opts: CrawlOptions): Promise<CrawlReport> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const kind = opts.kind ?? 'crawl';
  const startedAt = now();
  const runId = opts.runId ?? newRunId(kind, startedAt);
  const { selected, skipped } = selectBoards(opts.boards, opts.adapters, opts.sources);

  opts.db.logRun({ run_id: runId, started_at: startedAt.toISOString(), finished_at: null, kind, stats_json: null });
  log(`run ${runId}: ${selected.length} boards selected, ${skipped.length} skipped`);

  const diffs = await mapWithConcurrency(selected, opts.concurrency ?? 20, async ({ board, adapter }): Promise<BoardDiff> => {
    const args = { board, adapter, http: opts.http, db: opts.db, now, log };
    try {
      return await diffBoard(opts.detailCap === undefined ? args : { ...args, detailCap: opts.detailCap });
    } catch {
      // diffBoard handles its own errors; this is the last line of defence so one board can
      // never take the run (and its artifact) down with it.
      const id = boardIdOf(board);
      const prior = opts.db.getBoardState(id);
      log(`board ${id}: unexpected error`);
      return {
        board_id: id,
        ats: board.ats,
        ok: false,
        partial: false,
        error: 'error',
        consecutive_failures: (prior?.consecutive_failures ?? 0) + 1,
        counts: { listed: 0, new: 0, changed: 0, unchanged: 0, missing: 0, closed: 0, reopened: 0, reposts: 0, detail_fetched: 0, detail_deferred: 0 },
        new: [],
        changed: [],
        reposts: [],
        closed: [],
        reopened: [],
      };
    }
  });

  const perAts: Record<string, PerAts> = {};
  const bucket = (ats: Ats): PerAts => (perAts[ats] ??= emptyPerAts());
  for (const b of skipped) bucket(b.ats).skipped += 1;

  const report: CrawlReport = {
    run_id: runId,
    kind,
    started_at: startedAt.toISOString(),
    finished_at: startedAt.toISOString(),
    boards: { polled: selected.length, ok: 0, failed: 0, partial: 0, skipped: skipped.length },
    per_ats: perAts,
    jobs: { new: 0, changed: 0, closed: 0, reopened: 0, reposts: 0 },
    events: [],
    closed_keys: [],
    reopened_keys: [],
    failures: [],
    needs_refingerprint: [],
  };

  const events: JobEvent[] = [];
  for (const d of diffs) {
    const p = bucket(d.ats);
    p.polled += 1;
    if (!d.ok) {
      p.failed += 1;
      report.boards.failed += 1;
      report.failures.push({ board_id: d.board_id, code: d.error ?? 'error' });
      if (d.consecutive_failures >= 3) report.needs_refingerprint.push(d.board_id);
      continue;
    }
    p.ok += 1;
    report.boards.ok += 1;
    if (d.partial) {
      p.partial += 1;
      report.boards.partial += 1;
    }
    p.jobs.new += d.new.length;
    p.jobs.changed += d.changed.length;
    p.jobs.closed += d.closed.length;
    p.jobs.reopened += d.reopened.length;
    p.jobs.reposts += d.reposts.length;
    events.push(...d.new, ...d.changed, ...d.reposts);
    report.closed_keys.push(...d.closed);
    report.reopened_keys.push(...d.reopened);
  }
  report.jobs = {
    new: events.filter((e) => e.kind === 'new').length,
    changed: events.filter((e) => e.kind === 'changed').length,
    closed: report.closed_keys.length,
    reopened: report.reopened_keys.length,
    reposts: events.filter((e) => e.kind === 'repost').length,
  };
  report.events = events;

  const finishedAt = now();
  report.finished_at = finishedAt.toISOString();
  const stats = { boards: report.boards, jobs: report.jobs, failures: report.failures.length };
  opts.db.logRun({
    run_id: runId,
    started_at: report.started_at,
    finished_at: report.finished_at,
    kind,
    stats_json: JSON.stringify(stats),
  });
  log(
    `run ${runId}: boards ok=${report.boards.ok} failed=${report.boards.failed} partial=${report.boards.partial}; ` +
      `jobs new=${report.jobs.new} changed=${report.jobs.changed} closed=${report.jobs.closed} reopened=${report.jobs.reopened} reposts=${report.jobs.reposts}`,
  );
  return report;
}

export async function writeDiffArtifact(report: CrawlReport, path: string): Promise<void> {
  await writeFile(path, JSON.stringify(report), 'utf8');
}

export async function readDiffArtifact(path: string): Promise<CrawlReport> {
  const text = await readFile(path, 'utf8');
  return CrawlReportSchema.parse(JSON.parse(text));
}
