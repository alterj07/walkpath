/**
 * One-off maintainer script: discover Oracle Cloud HCM career sites and write the ones that answer
 * to `registry/seed/oracle.csv` (same header as registry/boards.csv). A maintainer reviews the file
 * and merges rows into boards.csv by pull request (plan 11.4); nothing here touches boards.csv.
 *
 *   node packages/pipeline/scripts/seed-oracle.ts [--limit N] [--out registry/seed/oracle.csv]
 *
 * Candidates: every `*.oraclecloud.com/hcmUI/CandidateExperience/<locale>/sites/<site>` URL in the
 * SimplifyJobs internship and new-grad lists, plus kalil0321/ats-scrapers' `ats-companies/oracle.csv`.
 * Each host/site pair is probed once (limit=1 list request) at 1 request per host with 1 s gaps and
 * at most 8 hosts in parallel. Only status codes and counts are logged. Re-runs keep `added_at`,
 * slugs and domains of rows already in the seed file.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { intFlag, parseArgs, stringFlag } from '../src/cli/args.ts';
import { createLogger } from '../src/cli/log.ts';
import { parseCsv } from '../src/registry/csv.ts';
import { parseBoardsCsv, serializeBoards, uniqueSlug } from '../src/registry/boards.ts';
import { fingerprintUrl } from '../src/registry/fingerprint.ts';
import { PoliteLimiter, probeBoard, probeHost, type ProbeTarget } from '../src/registry/probe.ts';
import { BoardSchema, type Board } from '../src/schema/board.ts';

const SIMPLIFY = [
  'https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json',
  'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json',
];
const ATS_SCRAPERS = 'https://raw.githubusercontent.com/kalil0321/ats-scrapers/main/ats-companies/oracle.csv';
const UA = 'WalkPathBot/1.0 (+https://github.com/alterj07/walkpath)';

interface Candidate {
  boardKey: string;
  name: string;
  careersUrl: string;
}

async function text(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${new URL(url).hostname}`);
  return res.text();
}

async function main(argv: readonly string[]): Promise<number> {
  const log = createLogger();
  const args = parseArgs(argv);
  const limit = intFlag(args, 'limit', 0);
  const out = stringFlag(args, 'out', 'registry/seed/oracle.csv');

  const candidates = new Map<string, Candidate>();
  const add = (url: string, name: string): void => {
    const fp = fingerprintUrl(url);
    if (!fp || fp.ats !== 'oracle' || !fp.boardKey) return;
    if (candidates.has(fp.boardKey)) return;
    const [host, site] = fp.boardKey.split('/');
    candidates.set(fp.boardKey, {
      boardKey: fp.boardKey,
      name,
      careersUrl: `https://${host}/hcmUI/CandidateExperience/en/sites/${site}`,
    });
  };

  for (const src of SIMPLIFY) {
    try {
      const rows = JSON.parse(await text(src)) as Array<{ url?: string; company_name?: string }>;
      const before = candidates.size;
      for (const r of rows) if (r.url) add(r.url, r.company_name ?? '');
      log.info('simplify list', { list: src.split('/')[4] ?? '', rows: rows.length, new_candidates: candidates.size - before });
    } catch (err) {
      log.warn('simplify list skipped', { code: err instanceof Error ? err.name : 'error' });
    }
  }
  try {
    const { rows } = parseCsv(await text(ATS_SCRAPERS));
    const before = candidates.size;
    for (const r of rows) add(r['url'] ?? '', r['name'] ?? '');
    log.info('ats-scrapers oracle.csv', { rows: rows.length, new_candidates: candidates.size - before });
  } catch (err) {
    log.warn('ats-scrapers inventory skipped', { code: err instanceof Error ? err.name : 'error' });
  }

  let list = [...candidates.values()];
  if (limit > 0) list = list.slice(0, limit);
  log.info('probing', { candidates: list.length });

  // Rows already in the seed file keep their added_at, slug and domain when re-run.
  const existing = new Map<string, Board>();
  try {
    for (const b of parseBoardsCsv(await readFile(out, 'utf8'))) existing.set(b.board_key, b);
  } catch {
    // no seed file yet
  }

  const limiter = new PoliteLimiter(8, (host) =>
    host.endsWith('.oraclecloud.com') ? { maxConcurrency: 1, minGapMs: 1000 } : { maxConcurrency: 2, minGapMs: 500 },
  );
  const counts = { active: 0, dropped: 0, needs_refingerprint: 0, status: {} as Record<string, number> };
  const today = new Date().toISOString().slice(0, 10);
  const taken = new Map<string, string>();
  for (const b of existing.values()) taken.set(b.company_slug, b.company_name);
  const boards: Board[] = [];
  let done = 0;
  await Promise.all(
    list.map(async (c) => {
      const target: ProbeTarget = { ats: 'oracle', boardKey: c.boardKey };
      const result = await limiter.run(probeHost(target), () => probeBoard(target));
      done += 1;
      counts.status[String(result.status)] = (counts.status[String(result.status)] ?? 0) + 1;
      if (done % 100 === 0) log.info('progress', { done, total: list.length });
      if (result.verdict === 'drop') {
        counts.dropped += 1;
        return;
      }
      counts[result.verdict] += 1;
      const prior = existing.get(c.boardKey);
      const name = c.name.trim() || prior?.company_name || (c.boardKey.split('/')[0] ?? 'oracle');
      const slug = prior?.company_slug ?? uniqueSlug(name, 'oracle', taken);
      boards.push(
        BoardSchema.parse({
          company_slug: slug,
          company_name: name,
          domain: prior?.domain ?? '',
          ats: 'oracle',
          board_key: c.boardKey,
          careers_url: c.careersUrl,
          added_at: prior?.added_at ?? today,
          status: result.verdict,
        }),
      );
    }),
  );
  boards.sort((a, b) => a.board_key.localeCompare(b.board_key));
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, serializeBoards(boards));
  log.info('seed written', { out, rows: boards.length, active: counts.active, needs_refingerprint: counts.needs_refingerprint, dropped: counts.dropped, statuses: JSON.stringify(counts.status) });
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
