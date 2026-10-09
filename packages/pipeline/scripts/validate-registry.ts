#!/usr/bin/env node
/**
 * CI check for registry/boards.csv (plan section 11.4).
 *
 *   node packages/pipeline/scripts/validate-registry.ts [--all] [--base origin/main]
 *
 * 1. Parses the whole file: schema errors and duplicate (ats, board_key) pairs fail the run.
 * 2. For rows added or changed relative to the base ref (git diff), confirms that
 *    - careers_url is on a known ATS host that fingerprints to the same board, or on the company's own domain, and
 *    - the board answers on its ATS public endpoint (one request; rows marked active must answer 200).
 *    `--all` checks every row instead of the diff (slow; maintainer use). Without git history and
 *    without --all the live check is skipped with a warning.
 * Exits non-zero with a readable report.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../src/registry/csv.ts';
import { fingerprintUrl } from '../src/registry/fingerprint.ts';
import { BOARDS_CSV_HEADER, type BoardRow, RegistryError, boardId, loadBoards } from '../src/registry/boards.ts';
import { PROBE_ATS, PoliteLimiter, type ProbeAts, defaultProbePolicy, probeBoard, probeHost } from '../src/registry/probe.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const BOARDS_CSV = path.join(ROOT, 'registry/boards.csv');
const REL = 'registry/boards.csv';

function parseArgs(argv: string[]) {
  const args = { all: false, base: 'origin/main' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--all') args.all = true;
    else if (a === '--base') args.base = argv[++i] ?? args.base;
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

/** Rows added or modified in the working tree relative to `base`, or null when git cannot tell. */
function changedRows(base: string, current: BoardRow[]): BoardRow[] | null {
  let diff: string;
  try {
    diff = execFileSync('git', ['diff', '--unified=0', '--no-color', base, '--', REL], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
  const added = diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));
  if (added.length === 0) return [];
  // Re-parse the added lines with the canonical header so quoted fields are handled correctly.
  const table = parseCsv(`${BOARDS_CSV_HEADER.join(',')}\n${added.join('\n')}\n`);
  const ids = new Set(table.rows.map((r) => `${r['ats']}:${r['board_key']}`));
  return current.filter((r) => ids.has(boardId(r)));
}

function hostMatchesDomain(host: string, domain: string): boolean {
  return domain !== '' && (host === domain || host.endsWith(`.${domain}`));
}

function checkCareersUrl(row: BoardRow): string | null {
  if (row.careers_url === '') return null;
  const host = new URL(row.careers_url).hostname.toLowerCase().replace(/^www\./, '');
  const fp = fingerprintUrl(row.careers_url);
  if (fp && fp.ats === row.ats && fp.boardKey === row.board_key) return null;
  if (fp && fp.ats !== 'deferred' && fp.boardKey !== null) {
    return `careers_url points at ${fp.ats}:${fp.boardKey}, not ${boardId(row)}`;
  }
  if (hostMatchesDomain(host, row.domain)) return null;
  return `careers_url host ${host} is neither a known ATS board URL for ${boardId(row)} nor the company domain "${row.domain || '(empty)'}"`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let rows: BoardRow[];
  try {
    rows = await loadBoards(BOARDS_CSV);
  } catch (e) {
    if (e instanceof RegistryError) {
      console.error(`FAIL ${REL}:`);
      for (const p of e.problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    throw e;
  }
  console.log(`${REL}: ${rows.length} rows parse cleanly, no duplicate boards`);

  let toCheck: BoardRow[];
  if (args.all) toCheck = rows;
  else {
    const changed = changedRows(args.base, rows);
    if (changed === null) {
      console.warn(`WARN cannot diff against ${args.base} (shallow clone or no git); skipping the live check. Use --all to probe every row.`);
      return;
    }
    toCheck = changed;
  }
  console.log(`live-checking ${toCheck.length} row(s)${args.all ? ' (--all)' : ` changed relative to ${args.base}`}`);
  if (toCheck.length === 0) return;

  const problems: string[] = [];
  const limiter = new PoliteLimiter(20, defaultProbePolicy);
  await Promise.all(
    toCheck.map(async (row) => {
      const id = boardId(row);
      const urlProblem = checkCareersUrl(row);
      if (urlProblem) problems.push(`${id}: ${urlProblem}`);
      if (!(PROBE_ATS as readonly string[]).includes(row.ats)) {
        problems.push(`${id}: no public endpoint known for ats "${row.ats}" yet; add it as needs_refingerprint or wait for the adapter`);
        return;
      }
      const target = { ats: row.ats as ProbeAts, boardKey: row.board_key, wd: row.wd ? Number(row.wd) : undefined };
      const result = await limiter.run(probeHost(target), () => probeBoard(target));
      if (result.resolvedBoardKey) problems.push(`${id}: board answers on api.eu.lever.co; key it as "${result.resolvedBoardKey}"`);
      else if (result.verdict === 'drop') problems.push(`${id}: board does not exist on ${row.ats} (http ${result.status})`);
      else if (result.verdict !== 'active' && row.status === 'active') problems.push(`${id}: marked active but the endpoint answered ${result.note} (http ${result.status})`);
    }),
  );

  if (problems.length) {
    console.error(`FAIL ${problems.length} problem(s):`);
    for (const p of problems.sort()) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`OK all ${toCheck.length} checked board(s) resolve on their ATS`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
