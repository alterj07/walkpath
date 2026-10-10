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
  /** Backfill mode: passed through to diffBoard (see DiffBoardOptions.forceRefresh). */
  forceRefresh?: boolean;
  /**
   * Wall-clock guard: once this returns true no further board is started; boards not
   * reached are counted in `boards.skipped_deadline` and polled next run. Never a failure.
   */
  shouldStop?: () => boolean;
  /**
   * Keeps only the events worth carrying in the artifact (e.g. titles that pass the internship
   * rule gate). Every job is still tracked in jobs_seen for diffing and closures; the filter only
   * shrinks diff-*.json, which otherwise carries every posting on every board on a first run.
   */
  eventFilter?: (event: JobEvent) => boolean;
  /**
   * Hard stop. When it fires, in-flight requests fail with 'aborted'; those boards count as
   * `skipped_deadline` (never as failures, never closures) and are polled first next run.
   * The HttpClient passed in must carry the same signal for the abort to reach the sockets.
   */
  signal?: AbortSignal;
}

const BoardCountsSchema = z.object({
  polled: z.number().int(),
  ok: z.number().int(),
  failed: z.number().int(),
  partial: z.number().int(),
  skipped: z.number().int(),
  /** Boards not started because the run hit its deadline (plan 4.4 budget). */
  skipped_deadline: z.number().int().default(0),
});

const JobCountsSchema = z.object({
  new: z.number().int(),
  changed: z.number().int(),
  closed: z.number().int(),
  reopened: z.number().int(),
  reposts: z.number().int(),
  /** Events dropped from the artifact by `eventFilter` (still tracked in jobs_seen). */
  filtered: z.number().int().optional(),
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
  skipped_deadline: 0,
  jobs: { new: 0, changed: 0, closed: 0, reopened: 0, reposts: 0, filtered: 0 },
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

/** A board the hard deadline cut off before its first request: nothing polled, nothing written. */
function abortedDiff(board: Board, db: StateDb): BoardDiff {
  const id = boardIdOf(board);
  const prior = db.getBoardState(id);
  return {
    board_id: id,
    ats: board.ats,
    ok: false,
    partial: false,
    error: 'aborted',
    consecutive_failures: prior?.consecutive_failures ?? 0,
    counts: { listed: 0, new: 0, changed: 0, unchanged: 0, missing: 0, closed: 0, reopened: 0, reposts: 0, detail_fetched: 0, detail_deferred: 0 },
    new: [],
    changed: [],
    reposts: [],
    closed: [],
    reopened: [],
  };
}

/** Runs `fn` over `items` with at most `limit` in flight; stops taking items once `shouldStop()` is true. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  shouldStop: () => boolean = () => false,
): Promise<{ results: R[]; unreached: T[] }> {
  const results: R[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      if (shouldStop()) return;
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  const unreached: T[] = [];
  const done: R[] = [];
  items.forEach((item, i) => {
    if (i in results) done.push(results[i] as R);
    else unreached.push(item);
  });
  return { results: done, unreached };
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

  const concurrency = opts.concurrency ?? 20;
  const runOne = async ({ board, adapter }: SelectedBoard): Promise<BoardDiff> => {
    if (opts.signal?.aborted) return abortedDiff(board, opts.db);
    const args = {
      board,
      adapter,
      http: opts.http,
      db: opts.db,
      now,
      log,
      ...(opts.detailCap === undefined ? {} : { detailCap: opts.detailCap }),
      ...(opts.forceRefresh === undefined ? {} : { forceRefresh: opts.forceRefresh }),
    };
    try {
      return await diffBoard(args);
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
  };

  // One worker pool per source so 40 global workers cannot all queue on one API host while
  // the other sources starve (plan 4.4 budgets are per host). A source whose boards live on
  // their own hosts (Workday) keeps the full worker count.
  const bySource = new Map<string, SelectedBoard[]>();
  for (const sb of selected) {
    const list = bySource.get(sb.adapter.source) ?? [];
    list.push(sb);
    bySource.set(sb.adapter.source, list);
  }
  const pools = await Promise.all(
    [...bySource.values()].map((items) => {
      const policy = items[0]?.adapter.policy;
      const perSource = policy?.hostsPerBoard ? concurrency : Math.min(concurrency, Math.max(1, (policy?.maxConcurrencyPerHost ?? 1) * 2));
      return mapWithConcurrency(items, perSource, runOne, opts.shouldStop);
    }),
  );
  const diffs = pools.flatMap((p) => p.results);
  const unreached = pools.flatMap((p) => p.unreached);

  const perAts: Record<string, PerAts> = {};
  const bucket = (ats: Ats): PerAts => (perAts[ats] ??= emptyPerAts());
  for (const b of skipped) bucket(b.ats).skipped += 1;
  for (const { board } of unreached) bucket(board.ats).skipped_deadline += 1;
  if (unreached.length > 0) log(`run ${runId}: deadline reached, ${unreached.length} boards not started`);

  const report: CrawlReport = {
    run_id: runId,
    kind,
    started_at: startedAt.toISOString(),
    finished_at: startedAt.toISOString(),
    boards: {
      polled: selected.length - unreached.length,
      ok: 0,
      failed: 0,
      partial: 0,
      skipped: skipped.length,
      skipped_deadline: unreached.length,
    },
    per_ats: perAts,
    jobs: { new: 0, changed: 0, closed: 0, reopened: 0, reposts: 0 },
    events: [],
    closed_keys: [],
    reopened_keys: [],
    failures: [],
    needs_refingerprint: [],
  };

  const events: JobEvent[] = [];

  let filtered = 0;
  for (const d of diffs) {
    const p = bucket(d.ats);
    p.polled += 1;
    if (!d.ok && d.error === 'aborted') {
      // Cut off by the hard deadline: not polled, not failed, polled first next run.
      p.polled -= 1;
      p.skipped_deadline += 1;
      report.boards.polled -= 1;
      report.boards.skipped_deadline += 1;
      report.failures.push({ board_id: d.board_id, code: 'aborted' });
      continue;
    }
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
    for (const e of [...d.new, ...d.changed, ...d.reposts]) {
      if (!opts.eventFilter || opts.eventFilter(e)) events.push(e);
      else filtered += 1;
    }
    report.closed_keys.push(...d.closed);
    report.reopened_keys.push(...d.reopened);
  }
  report.jobs = {
    new: events.filter((e) => e.kind === 'new').length,
    changed: events.filter((e) => e.kind === 'changed').length,
    closed: report.closed_keys.length,
    reopened: report.reopened_keys.length,
    reposts: events.filter((e) => e.kind === 'repost').length,
    filtered,
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
