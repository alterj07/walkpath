/**
 * Crawl entrypoint for the hourly workflow (plan 4.4, 8.1, 8.2).
 *
 *   node packages/pipeline/scripts/crawl.ts \
 *     --ats greenhouse,lever,ashby,workable,smartrecruiters \
 *     --boards registry/boards.csv --sources registry/sources.json \
 *     --state state/state-api.sqlite --out out/diff-api.json \
 *     [--concurrency 40] [--limit N] [--mode normal|backfill] [--deadline-min 25]
 *
 * Polls every active board of the requested sources, diffs against the SQLite state file,
 * runs the 45-day stale closure and 90-day prune, and writes the diff artifact the publish
 * job consumes. Exit codes: 0 when the run completed (even if some boards failed), 1 when
 * the registry is invalid, the state file cannot be opened, or nothing could be polled.
 * Logs print counts, ids and codes only; never titles, URLs, bodies or headers.
 */
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ArgError, enumFlag, intFlag, listFlag, parseArgs, stringFlag } from '../src/cli/args.ts';
import { createLogger } from '../src/cli/log.ts';
import { NO_DEADLINE, deadlineAfter, formatDuration, type Deadline } from '../src/cli/timing.ts';
import { adapterFor, type AnyAdapter } from '../src/adapters/index.ts';
import { closeStale, pruneClosed } from '../src/crawl/diff.ts';
import { crawlBoards, newRunId, writeDiffArtifact, type SourceToggles } from '../src/crawl/run.ts';
import { HttpClient } from '../src/http/client.ts';
import { loadBoards, loadSourcesConfig } from '../src/registry/boards.ts';
import { AtsSchema, type Ats } from '../src/schema/common.ts';
import type { Board } from '../src/schema/board.ts';
import { openState, type StateDb } from '../src/state/db.ts';

const API_SOURCES: readonly Ats[] = ['greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters'];
const MODES = ['normal', 'backfill'] as const;
type Mode = (typeof MODES)[number];

const log = createLogger();

/** Registry rows are already core `Board`s; keep only the requested sources. */
function selectSources(rows: readonly Board[], ats: ReadonlySet<Ats>): Board[] {
  return rows.filter((row) => ats.has(row.ats));
}

function parseAtsList(values: readonly string[]): Set<Ats> {
  const out = new Set<Ats>();
  for (const v of values) {
    const parsed = AtsSchema.safeParse(v);
    if (!parsed.success) throw new ArgError(`--ats: unknown source "${v}"`);
    out.add(parsed.data);
  }
  return out;
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const atsList = parseAtsList(listFlag(args, 'ats', API_SOURCES));
  const boardsPath = stringFlag(args, 'boards', 'registry/boards.csv');
  const sourcesPath = stringFlag(args, 'sources', 'registry/sources.json');
  const statePath = stringFlag(args, 'state', 'state/state-api.sqlite');
  const outPath = stringFlag(args, 'out', 'out/diff-api.json');
  const concurrency = intFlag(args, 'concurrency', 40, 1);
  const limit = intFlag(args, 'limit', 0, 0);
  const mode: Mode = enumFlag(args, 'mode', MODES, 'normal');
  const deadlineMin = intFlag(args, 'deadline-min', 0, 0);
  const deadline: Deadline = deadlineMin > 0 ? deadlineAfter(deadlineMin) : NO_DEADLINE;
  const kind = [...atsList].includes('workday') && atsList.size === 1 ? 'crawl-workday' : 'crawl-api';
  const startedAt = new Date();
  const runId = newRunId(kind, startedAt);

  log.info('crawl start', {
    run: runId,
    mode,
    ats: [...atsList].join(','),
    boards: boardsPath,
    sources: sourcesPath,
    state: statePath,
    out: outPath,
    concurrency,
    deadline_min: deadlineMin,
  });

  // Registry: an invalid file is fatal (exit 1).
  let rows: Board[];
  let sourcesConfig: Awaited<ReturnType<typeof loadSourcesConfig>>;
  try {
    rows = await loadBoards(boardsPath);
    sourcesConfig = await loadSourcesConfig(sourcesPath);
  } catch (err) {
    log.error('registry invalid', { code: err instanceof Error ? err.constructor.name : 'error' });
    return 1;
  }
  const allBoards = selectSources(rows, atsList);
  const boards = limit > 0 ? allBoards.slice(0, limit) : allBoards;

  const adapters: Partial<Record<Ats, AnyAdapter>> = {};
  for (const ats of atsList) {
    const adapter = adapterFor(ats);
    if (adapter === undefined) log.warn('no adapter for source; its boards are skipped', { ats });
    else adapters[ats] = adapter;
  }
  const sources: SourceToggles = {};
  for (const ats of atsList) {
    const toggle = sourcesConfig.sources[ats];
    if (toggle !== undefined) sources[ats] = { enabled: toggle.enabled };
  }

  if (boards.length === 0 || Object.keys(adapters).length === 0) {
    log.error('nothing to poll', { boards: boards.length, adapters: Object.keys(adapters).length });
    return 1;
  }

  // State: unopenable is fatal (exit 1). Closed in `finally` and on signals.
  let db: StateDb;
  try {
    await mkdir(dirname(statePath), { recursive: true });
    db = openState(statePath);
  } catch (err) {
    log.error('state open failed', { code: err instanceof Error ? err.constructor.name : 'error' });
    return 1;
  }
  let closed = false;
  const closeDb = (): void => {
    if (closed) return;
    closed = true;
    try {
      db.close();
    } catch {
      // Nothing useful to do on a close failure; the cache step will see whatever was flushed.
    }
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    log.warn('signal received, closing state', { code: signal });
    closeDb();
    process.exit(130);
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  try {
    const http = new HttpClient({});
    const report = await crawlBoards({
      boards,
      adapters,
      http,
      db,
      concurrency,
      sources,
      kind,
      runId,
      log: log.line,
      shouldStop: () => deadline.reached(),
      ...(mode === 'backfill' ? { forceRefresh: true, detailCap: Number.MAX_SAFE_INTEGER } : {}),
    });

    const now = new Date();
    const stale = closeStale(db, now);
    const pruned = pruneClosed(db, now);
    report.closed_keys.push(...stale);
    report.jobs.closed += stale.length;

    await mkdir(dirname(outPath), { recursive: true });
    await writeDiffArtifact(report, outPath);

    for (const [ats, p] of Object.entries(report.per_ats)) {
      log.info('ats summary', {
        ats,
        polled: p.polled,
        ok: p.ok,
        failed: p.failed,
        partial: p.partial,
        skipped: p.skipped,
        skipped_deadline: p.skipped_deadline,
        new: p.jobs.new,
        changed: p.jobs.changed,
        closed: p.jobs.closed,
        reopened: p.jobs.reopened,
        reposts: p.jobs.reposts,
      });
    }
    log.info('crawl done', {
      run: runId,
      polled: report.boards.polled,
      ok: report.boards.ok,
      failed: report.boards.failed,
      partial: report.boards.partial,
      skipped_deadline: report.boards.skipped_deadline,
      events: report.events.length,
      stale_closed: stale.length,
      pruned,
      needs_refingerprint: report.needs_refingerprint.length,
      elapsed: formatDuration(Date.now() - startedAt.getTime()),
      out: outPath,
    });
    if (report.boards.polled > 0 && report.boards.ok === 0) {
      log.error('every polled board failed', { failed: report.boards.failed });
      return 1;
    }
    return 0;
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    closeDb();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof ArgError) {
      log.error('bad arguments', { code: err.message });
    } else {
      log.error('crawl crashed', { code: err instanceof Error ? err.constructor.name : 'error' });
    }
    process.exitCode = 1;
  },
);
