/**
 * Local-model summarizer (plan 4.8 "local fallback"): drains the summary backlog with a llama.cpp
 * server running on the same machine, without any API key.
 *
 *   node packages/pipeline/scripts/summarize-local.ts \
 *     --data data --out data [--shard 0/4] [--max 400] [--deadline-min 45] \
 *     [--base-url http://127.0.0.1:8080] [--model qwen2.5-3b-instruct-q4_k_m]
 *
 * Reads every record in `<data>/jobs` and `<data>/pending` whose summary is null, keeps this
 * runner's shard, and writes one `<out>/summaries/<id>.json` per job. The next publish run folds
 * those files into the shards (`src/publish/summary-files.ts`). Exit 0 when the run completed
 * (even with nothing to do), 1 when the server never answered or the data dir is missing.
 * Logs print ids, counts and timings only; never posting text.
 */
import { stat } from 'node:fs/promises';
import { ArgError, intFlag, parseArgs, stringFlag } from '../src/cli/args.ts';
import { createLogger } from '../src/cli/log.ts';
import { parseShard } from '../src/cli/shard.ts';
import { NO_DEADLINE, deadlineAfter, formatDuration } from '../src/cli/timing.ts';
import { createSummarizer } from '../src/llm/chain.ts';
import { existingSummaryIds, listUnsummarized, selectRecords, summarizeRecords } from '../src/llm/local-summarize.ts';
import { createLocalLlamaProvider, LOCAL_LLAMA_DEFAULT_MODEL, LOCAL_LLAMA_DEFAULT_URL } from '../src/llm/providers/local-llama.ts';
import { openState } from '../src/state/db.ts';

async function waitForServer(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
}

async function main(argv: readonly string[]): Promise<number> {
  const log = createLogger();
  const args = parseArgs(argv);
  const dataDir = stringFlag(args, 'data', 'data');
  const outDir = stringFlag(args, 'out', dataDir);
  const shard = parseShard(stringFlag(args, 'shard', '0/1'));
  const max = intFlag(args, 'max', 400, 1);
  const deadlineMin = intFlag(args, 'deadline-min', 0);
  const baseUrl = stringFlag(args, 'base-url', LOCAL_LLAMA_DEFAULT_URL).replace(/\/+$/, '');
  const model = stringFlag(args, 'model', LOCAL_LLAMA_DEFAULT_MODEL);
  const deadline = deadlineMin > 0 ? deadlineAfter(deadlineMin) : NO_DEADLINE;
  const started = Date.now();

  log.info('summarize-local start', { data: dataDir, out: outDir, shard: `${shard.index}/${shard.count}`, max, deadline_min: deadlineMin, model });

  try {
    await stat(dataDir);
  } catch {
    log.error('data directory missing', { data: dataDir });
    return 1;
  }

  const all = await listUnsummarized(dataDir);
  const done = await existingSummaryIds(outDir);
  const records = selectRecords(all, shard, done, max);
  log.info('summarize-local selected', { unsummarized: all.length, already_written: done.size, selected: records.length });
  if (records.length === 0) {
    log.info('summarize-local done', { written: 0, elapsed: formatDuration(Date.now() - started) });
    return 0;
  }

  if (!(await waitForServer(baseUrl, 120_000))) {
    log.error('llama server not reachable', { base_url_host: new URL(baseUrl).host });
    return 1;
  }

  // Usage accounting goes to an in-memory state DB: the local model has no quota to track.
  const db = openState(':memory:');
  try {
    const summarizer = createSummarizer({ providers: [createLocalLlamaProvider({ baseUrl, model })], db, log: log.line });
    const result = await summarizeRecords({
      records,
      summarizer,
      outDir,
      ...(deadline === NO_DEADLINE ? {} : { deadlineMs: deadline.at }),
      log: log.line,
    });
    log.info('summarize-local done', {
      attempted: result.attempted,
      written: result.written,
      invalid: result.invalid,
      exhausted: result.exhausted,
      timed_out: result.timedOut,
      avg_ms_per_summary: result.avgMsPerSummary,
      elapsed: formatDuration(Date.now() - started),
    });
    return result.written === 0 && result.exhausted ? 1 : 0;
  } finally {
    db.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    const code = err instanceof ArgError ? 'args' : err instanceof Error ? err.name : 'error';
    console.error(`summarize-local failed: ${code}`);
    process.exit(1);
  },
);
