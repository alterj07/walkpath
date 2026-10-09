#!/usr/bin/env node
/**
 * Seed registry/boards.csv (plan section 4.1).
 *
 *   node packages/pipeline/scripts/seed-registry.ts [--limit N] [--only greenhouse,lever] [--revalidate] [--dry-run]
 *
 * Sources, in order:
 *   1. SimplifyJobs and vanshb03 Summer2026-Internships listings (companies that post tech internships).
 *   2. kalil0321/ats-scrapers board inventories for the six ATSs we poll.
 * Every candidate is validated with one request to the ATS public endpoint (see src/registry/probe.ts).
 * Verdicts are cached in state/registry-probe-cache.json for 7 days so re-runs are cheap and
 * idempotent; existing rows keep their added_at, and manually disabled rows stay disabled.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseCsv } from '../src/registry/csv.ts';
import { boardUrl, fingerprintUrl, type Fingerprint } from '../src/registry/fingerprint.ts';
import {
  type BoardRow,
  boardId,
  defaultSourcesConfig,
  loadBoards,
  serializeBoards,
  slugify,
} from '../src/registry/boards.ts';
import {
  HOSTNAME,
  PROBE_ATS,
  PROBE_USER_AGENT,
  PoliteLimiter,
  type ProbeAts,
  type ProbeResult,
  defaultProbePolicy,
  probeBoard,
  probeHost,
} from '../src/registry/probe.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const BOARDS_CSV = path.join(ROOT, 'registry/boards.csv');
const SAMPLE_CSV = path.join(ROOT, 'registry/sample.csv');
const SOURCES_JSON = path.join(ROOT, 'registry/sources.json');
const CACHE_FILE = path.join(ROOT, 'state/registry-probe-cache.json');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const LISTINGS = [
  { name: 'SimplifyJobs', url: 'https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json' },
  { name: 'vanshb03', url: 'https://raw.githubusercontent.com/vanshb03/Summer2026-Internships/dev/.github/scripts/listings.json' },
];
const INVENTORY_BASE = 'https://raw.githubusercontent.com/kalil0321/ats-scrapers/main/ats-companies/';

const ListingSchema = z.object({
  company_name: z.string().default(''),
  company_url: z.string().default(''),
  url: z.string().default(''),
  active: z.boolean().default(false),
});

interface Candidate {
  ats: ProbeAts;
  boardKey: string;
  wd?: number | undefined;
  fp: Fingerprint;
  names: string[]; // listing names first, inventory names after
  careersUrl: string;
  listingHits: number;
  domainHint: string;
}

const CacheEntry = z.object({
  verdict: z.enum(['active', 'drop', 'needs_refingerprint']),
  status: z.number(),
  note: z.string(),
  checkedAt: z.string(),
  domain: z.string().optional(),
  name: z.string().optional(),
  resolvedBoardKey: z.string().optional(),
});
type CacheEntry = z.infer<typeof CacheEntry>;

function parseArgs(argv: string[]) {
  const args = { limit: Infinity, only: new Set<ProbeAts>(), revalidate: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--only') (argv[++i] ?? '').split(',').forEach((s) => args.only.add(s.trim() as ProbeAts));
    else if (a === '--revalidate') args.revalidate = true;
    else if (a === '--dry-run') args.dryRun = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': PROBE_USER_AGENT }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url}: http ${res.status}`);
  return res.text();
}

function isProbeAts(ats: string): ats is ProbeAts {
  return (PROBE_ATS as readonly string[]).includes(ats);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

class Candidates {
  readonly byId = new Map<string, Candidate>();
  readonly otherAts = new Map<string, number>(); // fingerprinted but not pollable in the MVP
  unfingerprinted = 0;

  add(fp: Fingerprint | null, name: string, opts: { fromListing: boolean; domainHint?: string }): void {
    if (!fp || fp.boardKey === null) {
      this.unfingerprinted += 1;
      return;
    }
    if (!isProbeAts(fp.ats)) {
      const label = fp.ats === 'deferred' ? `deferred:${String(fp.meta?.vendor ?? '?')}` : fp.ats;
      this.otherAts.set(label, (this.otherAts.get(label) ?? 0) + 1);
      return;
    }
    const wd = fp.ats === 'workday' ? Number(fp.meta?.wd) : undefined;
    const id = `${fp.ats}:${fp.boardKey}`;
    let c = this.byId.get(id);
    if (!c) {
      c = { ats: fp.ats, boardKey: fp.boardKey, wd, fp, names: [], careersUrl: boardUrl(fp) ?? '', listingHits: 0, domainHint: '' };
      this.byId.set(id, c);
    }
    const clean = name.trim();
    if (clean && !c.names.includes(clean)) {
      if (opts.fromListing) c.names.unshift(clean);
      else c.names.push(clean);
    }
    if (opts.fromListing) c.listingHits += 1;
    if (opts.domainHint && !c.domainHint) c.domainHint = opts.domainHint;
  }
}

async function collectListings(c: Candidates): Promise<void> {
  for (const src of LISTINGS) {
    const rows = z.array(ListingSchema).parse(JSON.parse(await fetchText(src.url)));
    let matched = 0;
    for (const row of rows) {
      const companyHost = hostOf(row.company_url);
      const domainHint = companyHost && companyHost !== 'simplify.jobs' ? companyHost : '';
      const before = c.byId.size;
      c.add(fingerprintUrl(row.url), row.company_name, { fromListing: true, domainHint });
      if (domainHint) c.add(fingerprintUrl(row.company_url), row.company_name, { fromListing: true, domainHint });
      if (c.byId.size > before) matched += 1;
    }
    console.log(`listings ${src.name}: ${rows.length} rows, ${matched} new boards`);
  }
}

async function collectInventories(c: Candidates): Promise<void> {
  for (const ats of PROBE_ATS) {
    const text = await fetchText(`${INVENTORY_BASE}${ats}.csv`);
    const { rows } = parseCsv(text);
    let added = 0;
    for (const row of rows) {
      const url = row['url'] ?? '';
      const slug = row['slug'] ?? '';
      let fp = fingerprintUrl(url);
      if ((!fp || fp.ats !== ats) && slug && ats !== 'workday') {
        fp = { ats, boardKey: ats === 'smartrecruiters' ? slug : slug.toLowerCase() };
      }
      if (!fp || fp.ats !== ats) {
        c.unfingerprinted += 1;
        continue;
      }
      const before = c.byId.size;
      c.add(fp, row['name'] ?? '', { fromListing: false });
      if (c.byId.size > before) added += 1;
    }
    console.log(`inventory ${ats}: ${rows.length} rows, ${added} new boards`);
  }
}

async function loadCache(): Promise<Map<string, CacheEntry>> {
  if (!existsSync(CACHE_FILE)) return new Map();
  const raw = JSON.parse(await readFile(CACHE_FILE, 'utf8')) as Record<string, unknown>;
  const map = new Map<string, CacheEntry>();
  for (const [k, v] of Object.entries(raw)) {
    const parsed = CacheEntry.safeParse(v);
    if (parsed.success) map.set(k, parsed.data);
  }
  return map;
}

async function saveCache(cache: Map<string, CacheEntry>): Promise<void> {
  await mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(Object.fromEntries(cache), null, 0));
}

async function validateAll(list: Candidate[], cache: Map<string, CacheEntry>, revalidate: boolean) {
  const limiter = new PoliteLimiter(20, defaultProbePolicy);
  const results = new Map<string, ProbeResult>();
  let done = 0;
  let fromCache = 0;
  let lastSave = Date.now();
  const total = list.length;
  const started = Date.now();
  await Promise.all(
    list.map(async (c) => {
      const id = `${c.ats}:${c.boardKey}`;
      const cached = cache.get(id);
      const transient = cached !== undefined && (cached.status === 0 || cached.status === 429 || cached.status >= 500);
      if (cached && !revalidate && !transient && Date.now() - Date.parse(cached.checkedAt) < CACHE_TTL_MS) {
        const { verdict, status, note, domain, name, resolvedBoardKey } = cached;
        results.set(id, {
          verdict,
          status,
          note,
          ...(domain ? { domain } : {}),
          ...(name ? { name } : {}),
          ...(resolvedBoardKey ? { resolvedBoardKey } : {}),
        });
        fromCache += 1;
        done += 1;
        return;
      }
      const target = { ats: c.ats, boardKey: c.boardKey, wd: c.wd };
      const result = await limiter.run(probeHost(target), () => probeBoard(target));
      results.set(id, result);
      cache.set(id, { ...result, checkedAt: new Date().toISOString() });
      done += 1;
      if (done % 500 === 0 || Date.now() - lastSave > 30_000) {
        lastSave = Date.now();
        await saveCache(cache);
        const secs = Math.round((Date.now() - started) / 1000);
        console.log(`  probed ${done}/${total} (${fromCache} from cache) in ${secs}s`);
      }
    }),
  );
  await saveCache(cache);
  return { results, fromCache };
}

function pickSample(rows: BoardRow[], hits: Map<string, number>): BoardRow[] {
  const sample: BoardRow[] = [];
  for (const ats of ['greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters'] as const) {
    const pool = rows
      .filter((r) => r.ats === ats && r.status === 'active')
      .sort((a, b) => (hits.get(boardId(b)) ?? 0) - (hits.get(boardId(a)) ?? 0) || a.board_key.localeCompare(b.board_key));
    sample.push(...pool.slice(0, 5));
  }
  return sample;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const today = new Date().toISOString().slice(0, 10);

  const existing = existsSync(BOARDS_CSV) ? await loadBoards(BOARDS_CSV) : [];
  const existingById = new Map(existing.map((r) => [boardId(r), r] as const));
  console.log(`existing registry: ${existing.length} rows`);

  const candidates = new Candidates();
  await collectListings(candidates);
  await collectInventories(candidates);
  console.log(`candidates: ${candidates.byId.size} boards across ${PROBE_ATS.join(', ')}`);
  console.log(`not fingerprinted (custom sites, unresolved embeds, junk): ${candidates.unfingerprinted}`);
  console.log(`other ATSs seen (not polled in the MVP): ${JSON.stringify(Object.fromEntries(candidates.otherAts))}`);

  let list = [...candidates.byId.values()];
  if (args.only.size) list = list.filter((c) => args.only.has(c.ats));
  if (Number.isFinite(args.limit)) {
    // Keep a proportional, deterministic slice per ATS for dry runs.
    const perAts = Math.max(1, Math.floor(args.limit / PROBE_ATS.length));
    list = PROBE_ATS.flatMap((ats) => list.filter((c) => c.ats === ats).slice(0, perAts));
  }

  const cache = await loadCache();
  console.log(`validating ${list.length} boards (${cache.size} cached verdicts on disk)...`);
  const { results, fromCache } = await validateAll(list, cache, args.revalidate);

  const rows = new Map<string, BoardRow>(existingById);
  const hits = new Map<string, number>();
  const stats: Record<string, { candidates: number; active: number; needs_refingerprint: number; dropped: number }> = {};
  for (const ats of PROBE_ATS) stats[ats] = { candidates: 0, active: 0, needs_refingerprint: 0, dropped: 0 };

  for (const c of list) {
    const id = `${c.ats}:${c.boardKey}`;
    const r = results.get(id);
    if (!r) continue;
    const s = stats[c.ats] as (typeof stats)[string];
    s.candidates += 1;
    hits.set(id, c.listingHits);
    if (r.verdict === 'drop') {
      s.dropped += 1;
      rows.delete(id);
      continue;
    }
    s[r.verdict === 'active' ? 'active' : 'needs_refingerprint'] += 1;
    // A Lever site that only answers on api.eu.lever.co is re-keyed `eu:{site}`.
    const boardKey = r.resolvedBoardKey ?? c.boardKey;
    const finalId = `${c.ats}:${boardKey}`;
    if (finalId !== id) {
      rows.delete(id);
      hits.set(finalId, c.listingHits);
    }
    const prev = existingById.get(finalId) ?? existingById.get(id);
    const name = prev?.company_name || r.name || c.names[0] || c.boardKey;
    const domain = [prev?.domain, r.domain, c.domainHint].find((d) => d && HOSTNAME.test(d)) ?? '';
    const row: BoardRow = {
      company_slug: prev?.company_slug || slugify(name),
      company_name: name,
      domain,
      ats: c.ats,
      board_key: boardKey,
      careers_url: (finalId === id && prev?.careers_url) || boardUrl({ ats: c.ats, boardKey, meta: c.fp.meta ?? {} }) || c.careersUrl,
      added_at: prev?.added_at ?? today,
      status: prev?.status === 'disabled' ? 'disabled' : r.verdict,
      wd: c.wd ? String(c.wd) : '',
    };
    rows.set(finalId, row);
  }

  const all = [...rows.values()];
  console.log('\nats              candidates   active   needs_refingerprint   dropped');
  for (const [ats, s] of Object.entries(stats)) {
    console.log(`${ats.padEnd(16)} ${String(s.candidates).padStart(10)} ${String(s.active).padStart(8)} ${String(s.needs_refingerprint).padStart(21)} ${String(s.dropped).padStart(9)}`);
  }
  const totals = Object.values(stats).reduce(
    (a, s) => ({ candidates: a.candidates + s.candidates, active: a.active + s.active, needs_refingerprint: a.needs_refingerprint + s.needs_refingerprint, dropped: a.dropped + s.dropped }),
    { candidates: 0, active: 0, needs_refingerprint: 0, dropped: 0 },
  );
  console.log(`${'total'.padEnd(16)} ${String(totals.candidates).padStart(10)} ${String(totals.active).padStart(8)} ${String(totals.needs_refingerprint).padStart(21)} ${String(totals.dropped).padStart(9)}`);
  console.log(`probe results from cache: ${fromCache}; registry rows after merge: ${all.length} (active ${all.filter((r) => r.status === 'active').length})`);

  if (args.dryRun) {
    console.log('dry run: not writing registry files');
    return;
  }
  await mkdir(path.dirname(BOARDS_CSV), { recursive: true });
  await writeFile(BOARDS_CSV, serializeBoards(all));
  await writeFile(SAMPLE_CSV, serializeBoards(pickSample(all, hits)));
  if (!existsSync(SOURCES_JSON)) await writeFile(SOURCES_JSON, `${JSON.stringify(defaultSourcesConfig(), null, 2)}\n`);
  console.log(`wrote ${path.relative(ROOT, BOARDS_CSV)}, ${path.relative(ROOT, SAMPLE_CSV)}${existsSync(SOURCES_JSON) ? '' : `, ${path.relative(ROOT, SOURCES_JSON)}`}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
