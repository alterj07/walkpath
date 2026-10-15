import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { readDiffArtifact, type CrawlReport } from '../crawl/run.ts';
import { createSummarizer, providersFromEnv, summaryUsageReport, dayOf, type ProviderEnv, type Summarizer } from '../llm/chain.ts';
import { drainSummaryQueue, type DrainResult } from '../llm/queue.ts';
import type { SummaryOutput } from '../llm/schema.ts';
import { loadBoards, loadSourcesConfig, type SourcesConfig } from '../registry/boards.ts';
import { boardId, type Board } from '../schema/board.ts';
import type { JobRecord, JobSummary } from '../schema/job.ts';
import { openState, type StateDb } from '../state/db.ts';
import { discordPayloads, postDiscord, postTelegram, telegramMessages, type AlertFetch } from './alerts.ts';
import { buildFeed, feedTargets } from './feeds.ts';
import { MetaSchema, toIndexRow, type CompaniesFile, type IndexFile, type Meta } from './formats.ts';
import { applyEvents, buildGroupIndex, combinedGate, llmGateVerdict, type GroupedEntry, type HeldEntry, type MergeResult } from './merge.ts';
import { buildPagesList } from './pages.ts';
import { openStore, type Store } from './store.ts';
import { applySummaryFiles, type ApplySummaryFilesResult } from './summary-files.ts';

/**
 * The publish job (plan 4.4, 8.1): merge the crawl artifacts into the data-branch store,
 * run the gates, summarize new jobs through the free-tier chain, write the indexes, feeds
 * and meta, and post the hour's digest. Everything is file-based under `dataDir`:
 *
 *   jobs/<xx>.json        published records (BucketFile)
 *   pending/<xx>.json     records waiting on the LLM gate (not deployed)
 *   index/{latest,7d,all}.json, companies.json, pages.json, meta.json, grouped.json
 *   feeds/*.xml
 *   review/held.json, review/locations.json (not deployed)
 */

export const RETENTION_CLOSED_DAYS = 30;
export const HELD_RETENTION_DAYS = 90;
export const REVIEW_LOCATIONS_CAP = 500;
export const HELD_CAP = 2000;
export const ALERT_CAP_PER_RUN = 100;
export const CRON_MINUTE = 17;
/** Latency samples older than this are first-crawl backfill, not discovery latency (plan 3.2). */
export const LATENCY_MAX_MIN = 7 * 24 * 60;

/**
 * What the workflow copies from the data directory into the site's `dist/` (feeds at the root,
 * everything else under `/data`). `pending/` and `review/` are never deployed.
 */
export const DEPLOY_MAP: ReadonlyArray<{ from: string; to: string }> = [
  { from: 'feeds', to: 'feeds' },
  { from: 'index', to: 'data/index' },
  { from: 'jobs', to: 'data/jobs' },
  { from: 'companies.json', to: 'data/companies.json' },
  { from: 'pages.json', to: 'data/pages.json' },
  { from: 'meta.json', to: 'data/meta.json' },
  { from: 'grouped.json', to: 'data/grouped.json' },
];

export interface PublishEnv extends ProviderEnv {
  DISCORD_WEBHOOK_URL?: string | undefined;
  TELEGRAM_BOT_TOKEN?: string | undefined;
  TELEGRAM_CHAT_ID?: string | undefined;
  GITHUB_EVENT_NAME?: string | undefined;
  /** `true` disables Discord/Telegram posting without touching the secrets. */
  SUPPRESS_ALERTS?: string | undefined;
}

export interface PublishOptions {
  dataDir: string;
  artifacts: readonly string[];
  boardsPath: string;
  sourcesPath: string;
  /** The publish job's own state file (gate verdicts, summary queue, llm usage). */
  statePath: string;
  siteUrl: string;
  now?: () => Date;
  env?: PublishEnv;
  deadlineMs?: number;
  log?: (message: string) => void;
  fetch?: AlertFetch;
  /** Test seam: replaces the pacing sleep between alert messages. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: replaces the provider chain. */
  summarizer?: Summarizer;
  mode?: 'normal' | 'regate';
  alerts?: boolean;
  perRunCap?: number;
}

export interface PublishResult {
  skipped: boolean;
  run_id: string;
  artifacts_read: number;
  /** Artifacts present but failing the crawl report schema; skipped, their closures withheld. */
  artifacts_invalid: number;
  /** Summaries folded in from `summaries/*.json` (written by the local-model runner). */
  summaries_from_files: ApplySummaryFilesResult;
  /** Latency samples dropped because they exceeded LATENCY_MAX_MIN (first-crawl backfill). */
  latency_excluded: number;
  merge: MergeResult['counts'] & { published: number; updated: number; closed: number; reopened: number; ambiguous: number };
  llm: DrainResult | null;
  llm_gate: { published: number; dropped: number; waiting: number };
  regated: { removed: number; published: number } | null;
  retention_removed: number;
  files: string[];
  meta: Meta;
  alerts: { discord: number; telegram: number };
}

const HeldFileSchema = z.array(z.object({ id: z.string(), signals: z.array(z.string()), held_at: z.string() }));
const GroupedFileSchema = z.record(z.string(), z.object({ canonical: z.string(), location: z.string() }));
const LocationsFileSchema = z.array(z.string());

async function readJson<T>(path: string, schema: z.ZodType<T>, fallback: T, warn: (m: string) => void): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
    warn(`publish: ${path} fails its schema; starting from an empty one`);
  } catch {
    warn(`publish: ${path} is not valid JSON; starting from an empty one`);
  }
  return fallback;
}

async function writeText(root: string, rel: string, text: string, files: string[]): Promise<void> {
  const path = join(root, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  files.push(rel);
}

async function writeJson(root: string, rel: string, value: unknown, files: string[]): Promise<void> {
  await writeText(root, rel, JSON.stringify(value, null, 2) + '\n', files);
}

function byPostedDesc(a: JobRecord, b: JobRecord): number {
  return b.posted_at.localeCompare(a.posted_at) || b.first_seen_at.localeCompare(a.first_seen_at);
}

function minutesBetween(laterIso: string, earlierIso: string): number {
  return (Date.parse(laterIso) - Date.parse(earlierIso)) / 60_000;
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return Math.round((sorted[idx] as number) * 10) / 10;
}

/** Minutes past the hourly cron target (:17) for a scheduled run; null for manual runs. */
export function cronLatenessMin(startedAtIso: string, eventName: string | undefined): number | null {
  if (eventName !== 'schedule') return null;
  const d = new Date(startedAtIso);
  const minute = d.getUTCMinutes() + d.getUTCSeconds() / 60;
  const late = minute >= CRON_MINUTE ? minute - CRON_MINUTE : minute + 60 - CRON_MINUTE;
  return Math.round(late * 10) / 10;
}

/** Apply LLM-derived fields that the rule parsers could not determine. */
export function enrichFromSummary(record: JobRecord, output: SummaryOutput): JobRecord {
  return {
    ...record,
    season: record.season ?? output.season,
    grad_years: record.grad_years.length > 0 ? record.grad_years : output.grad_years,
    citizenship_required: record.citizenship_required ?? output.citizenship_required,
    sponsorship: record.sponsorship === 'unknown' ? output.sponsorship : record.sponsorship,
  };
}

interface Context {
  opts: PublishOptions;
  now: Date;
  log: (m: string) => void;
  db: StateDb;
  store: Store;
  pending: Store;
  held: HeldEntry[];
  grouped: Record<string, GroupedEntry>;
  files: string[];
  llmGate: PublishResult['llm_gate'];
  publishedByLlm: JobRecord[];
}

/**
 * The one place a summary enters the stores: enrichment for published records, the LLM gate for
 * pending (ambiguous) ones. Shared by the in-process provider chain and the summary files that
 * the local-model runner commits to the data branch.
 */
function makeSaveSummary(ctx: Context): (jobId: string, summary: JobSummary, output: SummaryOutput) => Promise<void> {
  const { db, store, pending } = ctx;
  return async (jobId, summary, output) => {
    const inStore = await store.get(jobId);
    if (inStore) {
      await store.put(enrichFromSummary({ ...inStore, summary }, output));
      return;
    }
    const waiting = await pending.get(jobId);
    if (!waiting) return;
    const verdict = llmGateVerdict(output);
    const key = db.getJobById(jobId)?.canonical_key;
    if (verdict === 'wait') {
      await pending.put({ ...waiting, summary });
      ctx.llmGate.waiting += 1;
      if (key) db.setGate(key, 'pending', 'llm');
      return;
    }
    await pending.delete(jobId);
    // The verdict is recorded per canonical key so the same content is never re-summarized.
    if (key) db.setGate(key, verdict === 'drop' ? 'not_tech' : 'tech_intern', 'llm');
    if (verdict === 'drop') {
      ctx.llmGate.dropped += 1;
      return;
    }
    const family = output.role_family === 'not_tech' ? waiting.role_family : output.role_family;
    const record = enrichFromSummary({ ...waiting, summary, role_family: family, closed_at: null }, output);
    await store.put(record);
    ctx.llmGate.published += 1;
    ctx.publishedByLlm.push(record);
  };
}

async function runSummaries(ctx: Context, summarizer: Summarizer): Promise<DrainResult> {
  const { db, store, pending } = ctx;
  return drainSummaryQueue({
    db,
    summarizer,
    ...(ctx.opts.perRunCap !== undefined ? { perRunCap: ctx.opts.perRunCap } : {}),
    ...(ctx.opts.deadlineMs !== undefined ? { deadlineMs: ctx.opts.deadlineMs } : {}),
    now: () => (ctx.opts.now ? ctx.opts.now().getTime() : Date.now()),
    log: ctx.log,
    loadJob: async (jobId) => {
      const record = (await store.get(jobId)) ?? (await pending.get(jobId));
      if (!record) return null;
      const location = [record.location.city, record.location.state].filter(Boolean).join(', ') || record.location.raw;
      return { job_id: jobId, title: record.title_raw, company: record.company.name, location, descriptionHtml: record.description_html };
    },
    saveSummary: makeSaveSummary(ctx),
  });
}

/** Re-run the rule gates on every stored and pending record (dispatch mode `regate`), no LLM calls. */
async function regate(ctx: Context): Promise<{ removed: number; published: number }> {
  let removed = 0;
  let published = 0;
  // Every stored record was already admitted as an internship, so the rules re-run with the
  // employment type pinned to 'Intern': only the seniority/years veto or not_tech can remove it.
  for (const record of await ctx.store.all()) {
    const g = combinedGate(record.title_raw, 'Intern', null);
    if (g.gate === 'not_intern' || g.gate === 'not_tech') {
      await ctx.store.delete(record.id);
      ctx.db.removeSummary(record.id);
      removed += 1;
    } else if (g.gate === 'tech_intern' && g.family && g.family !== record.role_family) {
      await ctx.store.put({ ...record, role_family: g.family, employment_type: g.employment_type });
    }
  }
  for (const record of await ctx.pending.all()) {
    const g = combinedGate(record.title_raw, 'Intern', null);
    if (g.gate === 'not_intern' || g.gate === 'not_tech') {
      await ctx.pending.delete(record.id);
      ctx.db.removeSummary(record.id);
      removed += 1;
    } else if (g.gate === 'tech_intern' && g.family) {
      await ctx.pending.delete(record.id);
      await ctx.store.put({ ...record, role_family: g.family, employment_type: g.employment_type, closed_at: null });
      published += 1;
    }
  }
  return { removed, published };
}

export async function publish(opts: PublishOptions): Promise<PublishResult> {
  const now = (opts.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const log = opts.log ?? (() => {});
  const env = opts.env ?? {};
  const files: string[] = [];
  const runId = `publish-${nowIso.replace(/[-:.]/g, '').slice(0, 15)}`;

  const sources: SourcesConfig = await loadSourcesConfig(opts.sourcesPath);
  const boards: Board[] = await loadBoards(opts.boardsPath);
  const boardsById = new Map<string, Board>();
  for (const b of boards) boardsById.set(boardId(b), b);

  const db = openState(opts.statePath);
  try {
    const emptyMeta: Meta = {
      last_run_at: nowIso,
      run_id: runId,
      boards: {},
      jobs: { open: 0, new: 0, closed: 0 },
      latency: { median_min: null, p90_min: null },
      llm: {},
      pending_summaries: db.countPendingSummaries(),
      held_for_review: 0,
      schedule: { started_at: nowIso, lateness_min: null },
    };
    const llmGate = { published: 0, dropped: 0, waiting: 0 };
    const emptyMerge = { events: 0, not_intern: 0, not_tech: 0, non_us: 0, held: 0, unknown_board: 0, grouped: 0, skipped_llm_negative: 0 };
    if (sources.publish?.enabled === false) {
      log('publish: disabled by registry/sources.json; nothing written');
      return {
        skipped: true,
        run_id: runId,
        artifacts_read: 0,
        artifacts_invalid: 0,
        summaries_from_files: { files: 0, applied: 0, invalid: 0, hash_mismatch: 0, missing: 0 },
        latency_excluded: 0,
        merge: { ...emptyMerge, published: 0, updated: 0, closed: 0, reopened: 0, ambiguous: 0 },
        llm: null,
        llm_gate: llmGate,
        regated: null,
        retention_removed: 0,
        files,
        meta: emptyMeta,
        alerts: { discord: 0, telegram: 0 },
      };
    }

    // Artifacts: a missing one is skipped (crawl-workday may be disabled); an invalid one is skipped
    // with a warning, which also withholds its closures until a valid artifact arrives.
    const reports: CrawlReport[] = [];
    let artifactsInvalid = 0;
    for (const path of opts.artifacts) {
      try {
        reports.push(await readDiffArtifact(path));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          log(`publish: artifact missing, skipped: ${path}`);
          continue;
        }
        artifactsInvalid += 1;
        log(`publish: artifact invalid, skipped (closures withheld): ${path}`);
      }
    }

    const store = openStore(join(opts.dataDir, 'jobs'));
    const pending = openStore(join(opts.dataDir, 'pending'));
    const held = await readJson(join(opts.dataDir, 'review', 'held.json'), HeldFileSchema, [] as HeldEntry[], log);
    const grouped = await readJson(join(opts.dataDir, 'grouped.json'), GroupedFileSchema, {} as Record<string, GroupedEntry>, log);
    const locations = await readJson(join(opts.dataDir, 'review', 'locations.json'), LocationsFileSchema, [] as string[], log);
    const groups = await buildGroupIndex(store);
    const ctx: Context = { opts, now, log, db, store, pending, held, grouped, files, llmGate, publishedByLlm: [] };

    db.logRun({ run_id: runId, started_at: nowIso, finished_at: null, kind: opts.mode === 'regate' ? 'publish-regate' : 'publish', stats_json: null });

    // 1. Merge events and closures from every artifact.
    const mergeTotals = { ...emptyMerge, published: 0, updated: 0, closed: 0, reopened: 0, ambiguous: 0 };
    const alertable: JobRecord[] = [];
    const newThisRun: JobRecord[] = [];
    const unparsed = new Set(locations);
    for (const report of reports) {
      const merged = await applyEvents({
        events: report.events,
        closedKeys: report.closed_keys,
        reopenedKeys: report.reopened_keys,
        boardsById,
        now,
        db,
        store,
        pending,
        held,
        grouped,
        groups,
        log,
      });
      for (const k of Object.keys(emptyMerge) as Array<keyof typeof emptyMerge>) mergeTotals[k] += merged.counts[k];
      mergeTotals.published += merged.published.length;
      mergeTotals.updated += merged.updated;
      mergeTotals.closed += merged.closed;
      mergeTotals.reopened += merged.reopened;
      mergeTotals.ambiguous += merged.ambiguous.length;
      alertable.push(...merged.alertable);
      newThisRun.push(...merged.published);
      for (const l of merged.unparsedLocations) unparsed.add(l);
    }

    // 2. Regate (dispatch mode) re-runs the rules over everything stored; no LLM.
    let regated: PublishResult['regated'] = null;
    if (opts.mode === 'regate') regated = await regate(ctx);

    // 2b. Summaries produced elsewhere (the local-model runner commits `summaries/<id>.json` to the
    // data branch): fold them in through the same save path, then remove the files. Idempotent.
    const save = makeSaveSummary(ctx);
    const summariesFromFiles = await applySummaryFiles({
      dataDir: opts.dataDir,
      store,
      pending,
      apply: async (jobId, summary, output) => {
        await save(jobId, summary, output);
        db.removeSummary(jobId);
      },
      log,
    });
    const publishedFromFiles = ctx.publishedByLlm.splice(0);
    newThisRun.push(...publishedFromFiles);
    alertable.push(...publishedFromFiles);

    // 3. Summaries through the provider chain; ambiguous records get their LLM gate here.
    let llm: DrainResult | null = null;
    if (opts.mode !== 'regate') {
      const summarizer = opts.summarizer ?? createSummarizer({ providers: providersFromEnv(env), db, log });
      llm = await runSummaries(ctx, summarizer);
      newThisRun.push(...ctx.publishedByLlm);
      alertable.push(...ctx.publishedByLlm);
    }

    // 4. Retention: closed > 30 days leave the shards; held entries age out at 90 days.
    const closedCutoff = new Date(now.getTime() - RETENTION_CLOSED_DAYS * 86_400_000).toISOString();
    const retentionRemoved = await store.removeClosedBefore(closedCutoff);
    const heldCutoff = new Date(now.getTime() - HELD_RETENTION_DAYS * 86_400_000).toISOString();
    const heldKept = held.filter((h) => h.held_at >= heldCutoff).slice(-HELD_CAP);
    const allRecords = await store.all();
    const liveIds = new Set(allRecords.map((r) => r.id));
    for (const id of Object.keys(grouped)) {
      const entry = grouped[id];
      if (!entry || !liveIds.has(entry.canonical)) delete grouped[id];
    }

    // 5. Outputs.
    await store.writeChanged();
    await pending.writeChanged();
    const open = allRecords.filter((r) => r.closed_at === null).sort(byPostedDesc);
    const dayMs = 86_400_000;
    const latest = open.filter((r) => Date.parse(r.posted_at) >= now.getTime() - dayMs);
    const sevenDays = open.filter((r) => Date.parse(r.posted_at) >= now.getTime() - 7 * dayMs);
    const indexFile = (rows: JobRecord[]): IndexFile => ({ generated_at: nowIso, rows: rows.map(toIndexRow) });
    await writeJson(opts.dataDir, 'index/latest.json', indexFile(latest), files);
    await writeJson(opts.dataDir, 'index/7d.json', indexFile(sevenDays), files);
    await writeJson(opts.dataDir, 'index/all.json', indexFile(open), files);

    const companies: CompaniesFile = {};
    const openBySlug = new Map<string, number>();
    for (const r of open) openBySlug.set(r.company.slug, (openBySlug.get(r.company.slug) ?? 0) + 1);
    for (const b of boards) {
      const count = openBySlug.get(b.company_slug);
      if (!count) continue;
      const entry = companies[b.company_slug];
      if (entry) {
        if (!entry.ats.includes(b.ats)) entry.ats.push(b.ats);
        if (!entry.domain && b.domain) entry.domain = b.domain;
      } else {
        companies[b.company_slug] = {
          name: b.company_name,
          domain: b.domain,
          blurb: null,
          ats: [b.ats],
          careers_url: b.careers_url || null,
          open_count: count,
        };
      }
    }
    for (const r of open) {
      if (!companies[r.company.slug]) {
        companies[r.company.slug] = {
          name: r.company.name,
          domain: r.company.domain,
          blurb: null,
          ats: [r.source.ats],
          careers_url: null,
          open_count: openBySlug.get(r.company.slug) ?? 0,
        };
      }
    }
    const sortedCompanies: CompaniesFile = {};
    for (const slug of Object.keys(companies).sort()) sortedCompanies[slug] = companies[slug] as CompaniesFile[string];
    await writeJson(opts.dataDir, 'companies.json', sortedCompanies, files);
    await writeJson(opts.dataDir, 'pages.json', buildPagesList(open), files);
    await writeJson(opts.dataDir, 'grouped.json', grouped, files);

    for (const target of feedTargets(open)) {
      const items = open.filter(target.matches);
      const xml = buildFeed({ title: target.title, siteUrl: opts.siteUrl, selfPath: `/${target.file}`, updated: nowIso, items });
      await writeText(opts.dataDir, target.file, xml, files);
    }

    await writeJson(opts.dataDir, 'review/held.json', heldKept, files);
    await writeJson(opts.dataDir, 'review/locations.json', [...unparsed].slice(-REVIEW_LOCATIONS_CAP), files);

    // 6. meta.json (plan 2.7).
    const boardsMeta: Meta['boards'] = {};
    for (const report of reports) {
      for (const [ats, c] of Object.entries(report.per_ats)) {
        const prev = boardsMeta[ats] ?? { polled: 0, ok: 0, failed: 0 };
        boardsMeta[ats] = { polled: prev.polled + c.polled, ok: prev.ok + c.ok, failed: prev.failed + c.failed };
      }
    }
    const rawLatencies = newThisRun
      .filter((r) => r.posted_at_source === 'ATS_FIELD')
      .map((r) => minutesBetween(r.first_seen_at, r.posted_at))
      .filter((m) => Number.isFinite(m) && m >= 0);
    const latencies = rawLatencies.filter((m) => m <= LATENCY_MAX_MIN).sort((a, b) => a - b);
    const latencyExcluded = rawLatencies.length - latencies.length;
    if (latencyExcluded > 0) log(`publish: latency samples older than 7 days excluded: ${latencyExcluded}`);
    const earliestStart = reports.map((r) => r.started_at).sort()[0] ?? nowIso;
    const meta: Meta = MetaSchema.parse({
      last_run_at: nowIso,
      run_id: runId,
      boards: boardsMeta,
      jobs: { open: open.length, new: newThisRun.length, closed: mergeTotals.closed },
      latency: { median_min: percentile(latencies, 0.5), p90_min: percentile(latencies, 0.9) },
      llm: summaryUsageReport(db, dayOf(now.getTime())),
      pending_summaries: db.countPendingSummaries(),
      held_for_review: heldKept.length,
      schedule: { started_at: earliestStart, lateness_min: cronLatenessMin(earliestStart, env.GITHUB_EVENT_NAME) },
    });
    await writeJson(opts.dataDir, 'meta.json', meta, files);

    // 7. Alerts for this run's genuinely new records (never reposts or changes).
    const alerts = { discord: 0, telegram: 0 };
    const suppressed = env.SUPPRESS_ALERTS === 'true';
    if (suppressed) log('publish: alerts=false reason=suppressed');
    if (opts.alerts !== false && !suppressed && alertable.length > 0) {
      const digest = [...alertable].sort(byPostedDesc).slice(0, ALERT_CAP_PER_RUN);
      const post = { ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.sleep ? { sleep: opts.sleep } : {}) };
      if (env.DISCORD_WEBHOOK_URL) {
        const r = await postDiscord(env.DISCORD_WEBHOOK_URL, discordPayloads(digest, { siteUrl: opts.siteUrl, now }), post);
        alerts.discord = r.sent;
      }
      if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
        const r = await postTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, telegramMessages(digest, { siteUrl: opts.siteUrl, now }), post);
        alerts.telegram = r.sent;
      }
    }

    const result: PublishResult = {
      skipped: false,
      run_id: runId,
      artifacts_read: reports.length,
      artifacts_invalid: artifactsInvalid,
      summaries_from_files: summariesFromFiles,
      latency_excluded: latencyExcluded,
      merge: mergeTotals,
      llm,
      llm_gate: llmGate,
      regated,
      retention_removed: retentionRemoved,
      files,
      meta,
      alerts,
    };
    db.logRun({
      run_id: runId,
      started_at: nowIso,
      finished_at: new Date().toISOString(),
      kind: opts.mode === 'regate' ? 'publish-regate' : 'publish',
      stats_json: JSON.stringify({ merge: mergeTotals, llm, llm_gate: llmGate, retention_removed: retentionRemoved, alerts }),
    });
    log(
      `publish done run=${runId} artifacts=${reports.length} open=${open.length} new=${newThisRun.length} closed=${mergeTotals.closed} ` +
        `summaries=${llm ? `${llm.succeeded}/${llm.attempted} remaining=${llm.remaining}` : 'skipped'} held=${heldKept.length} files=${files.length}`,
    );
    return result;
  } finally {
    db.close();
  }
}
