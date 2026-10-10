/**
 * Publish entrypoint for the hourly workflow (plan 4.4 "publish" job, 8.1, 8.2).
 *
 *   node packages/pipeline/scripts/publish.ts \
 *     --data data --artifacts out/diff-api.json,out/diff-workday.json \
 *     --boards registry/boards.csv --sources registry/sources.json \
 *     --state state/state-publish.sqlite --site-url https://walkpath.pages.dev \
 *     [--deadline-min 12] [--mode normal|regate] [--no-alerts] [--summary-cap 1500]
 *
 * Merges the crawl artifacts into the data directory, runs the gates, summarizes through the
 * free-tier LLM chain (keys from the environment; missing keys mean "summary pending"),
 * writes indexes, feeds and meta.json, and posts the Discord/Telegram digest. `regate`
 * re-runs the rule gates on every stored record without LLM calls. Exit codes: 0 when the
 * run completed, 1 when the registry, the state file or the store could not be used.
 * Logs print counts, ids and codes only; never titles, URLs, bodies or keys.
 */
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ArgError, boolFlag, enumFlag, intFlag, listFlag, parseArgs, stringFlag } from '../src/cli/args.ts';
import { createLogger } from '../src/cli/log.ts';
import { NO_DEADLINE, deadlineAfter, formatDuration, type Deadline } from '../src/cli/timing.ts';
import { publish, type PublishEnv } from '../src/publish/orchestrate.ts';

const MODES = ['normal', 'regate'] as const;

function envFromProcess(): PublishEnv {
  const e = process.env;
  return {
    MISTRAL_API_KEY: e.MISTRAL_API_KEY,
    GEMINI_API_KEY: e.GEMINI_API_KEY,
    CLOUDFLARE_ACCOUNT_ID: e.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_AI_TOKEN: e.CLOUDFLARE_AI_TOKEN,
    GROQ_API_KEY: e.GROQ_API_KEY,
    GITHUB_MODELS_TOKEN: e.GITHUB_MODELS_TOKEN,
    DISCORD_WEBHOOK_URL: e.DISCORD_WEBHOOK_URL,
    TELEGRAM_BOT_TOKEN: e.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: e.TELEGRAM_CHAT_ID,
    GITHUB_EVENT_NAME: e.GITHUB_EVENT_NAME,
    SUPPRESS_ALERTS: e.SUPPRESS_ALERTS,
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const log = createLogger();
  const args = parseArgs(argv);
  const dataDir = stringFlag(args, 'data', 'data');
  const artifacts = listFlag(args, 'artifacts', ['out/diff-api.json', 'out/diff-workday.json']);
  const boardsPath = stringFlag(args, 'boards', 'registry/boards.csv');
  const sourcesPath = stringFlag(args, 'sources', 'registry/sources.json');
  const statePath = stringFlag(args, 'state', 'state/state-publish.sqlite');
  const siteUrl = stringFlag(args, 'site-url', process.env.SITE_URL ?? 'https://walkpath.pages.dev').replace(/\/+$/, '');
  const deadlineMin = intFlag(args, 'deadline-min', 12, 0);
  const mode = enumFlag(args, 'mode', MODES, 'normal');
  const noAlerts = boolFlag(args, 'no-alerts', false);
  const summaryCap = intFlag(args, 'summary-cap', 1500, 1);
  const deadline: Deadline = deadlineMin > 0 ? deadlineAfter(deadlineMin) : NO_DEADLINE;
  const started = Date.now();
  const env = envFromProcess();

  log.info('publish start', {
    data: dataDir,
    artifacts: artifacts.length,
    boards: boardsPath,
    sources: sourcesPath,
    state: statePath,
    mode,
    deadline_min: deadlineMin,
    alerts: !noAlerts && process.env.SUPPRESS_ALERTS !== 'true',
    llm_providers: ['MISTRAL_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_AI_TOKEN', 'GROQ_API_KEY', 'GITHUB_MODELS_TOKEN'].filter(
      (k) => !!process.env[k],
    ).length,
  });

  await mkdir(dirname(statePath), { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const result = await publish({
    dataDir,
    artifacts,
    boardsPath,
    sourcesPath,
    statePath,
    siteUrl,
    env,
    ...(deadline === NO_DEADLINE ? {} : { deadlineMs: deadline.at }),
    log: log.line,
    mode,
    alerts: !noAlerts,
    perRunCap: summaryCap,
  });

  if (result.skipped) {
    log.warn('publish skipped: disabled in sources.json');
    return 0;
  }
  log.info('publish summary', {
    run: result.run_id,
    artifacts: result.artifacts_read,
    artifacts_invalid: result.artifacts_invalid,
    events: result.merge.events,
    published: result.merge.published,
    updated: result.merge.updated,
    ambiguous: result.merge.ambiguous,
    not_intern: result.merge.not_intern,
    not_tech: result.merge.not_tech,
    non_us: result.merge.non_us,
    held: result.merge.held,
    grouped: result.merge.grouped,
    skipped_llm_negative: result.merge.skipped_llm_negative,
    deduped_listing: result.merge.deduped_listing,
    closed: result.merge.closed,
    reopened: result.merge.reopened,
    open: result.meta.jobs.open,
    summaries_ok: result.llm?.succeeded ?? 0,
    summaries_invalid: result.llm?.invalid ?? 0,
    summaries_remaining: result.meta.pending_summaries,
    llm_exhausted: result.llm?.exhausted ?? false,
    llm_gate_published: result.llm_gate.published,
    llm_gate_dropped: result.llm_gate.dropped,
    retention_removed: result.retention_removed,
    median_latency_min: result.meta.latency.median_min,
    latency_excluded: result.latency_excluded,
    discord: result.alerts.discord,
    telegram: result.alerts.telegram,
    files: result.files.length,
    elapsed: formatDuration(Date.now() - started),
  });
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const log = createLogger();
    if (err instanceof ArgError) log.error('bad arguments', { code: 'ArgError' });
    else log.error('publish failed', { code: err instanceof Error ? err.constructor.name : 'error', message: err instanceof Error ? err.message.slice(0, 200) : 'unknown' });
    process.exitCode = 1;
  },
);
