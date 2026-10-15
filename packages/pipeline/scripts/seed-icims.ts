/**
 * One-off maintainer seed for iCIMS portals → registry/seed/icims.csv (same header as boards.csv).
 *
 *   node packages/pipeline/scripts/seed-icims.ts [--limit N] [--concurrency 8]
 *
 * Candidates come from the SimplifyJobs internship and new-grad lists (every `*.icims.com` apply
 * URL) and, when present, the kalil0321/ats-scrapers inventory. Each portal label is probed once
 * with the mobile search page (`probeBoard`, HTML markers): a page with job cards is `active`, a
 * search page with no cards is dropped, anything else is `needs_refingerprint`. Portals whose
 * robots.txt disallows `/` are written as `disabled` so the crawl never touches them (the crawl
 * client honours robots anyway; this keeps /status honest). One request per host, 2 s apart,
 * 8 hosts in parallel; statuses only are logged.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOARDS_CSV_HEADER, parseBoardsCsv, serializeBoards, slugify } from '../src/registry/boards.ts';
import { PROBE_USER_AGENT, probeBoard } from '../src/registry/probe.ts';
import type { Board } from '../src/schema/board.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const OUT = `${ROOT}registry/seed/icims.csv`;
const LISTS = [
  'https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json',
  'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json',
];
const INVENTORY = 'https://raw.githubusercontent.com/kalil0321/ats-scrapers/main/ats-companies/icims.csv';
const LABEL = /^https?:\/\/([a-z0-9][a-z0-9-]{0,62})\.icims\.com\//i;
const SKIP_LABELS = new Set(['www', 'cdn01', 'cdn02', 'media', 'images', 'care', 'platform']);

interface Candidate {
  label: string;
  company: string;
  hits: number;
}

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

async function text(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { 'user-agent': PROBE_USER_AGENT }, signal: AbortSignal.timeout(60_000) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

async function candidates(): Promise<Map<string, Candidate>> {
  const out = new Map<string, Candidate>();
  const add = (label: string, company: string) => {
    const key = label.toLowerCase();
    if (SKIP_LABELS.has(key)) return;
    const c = out.get(key);
    if (c) c.hits += 1;
    else out.set(key, { label: key, company: company.trim(), hits: 1 });
  };
  for (const url of LISTS) {
    const body = await text(url);
    if (!body) {
      console.log(`list unavailable: ${new URL(url).pathname.split('/')[2]}`);
      continue;
    }
    let rows: Array<{ url?: string; company_name?: string }> = [];
    try {
      rows = JSON.parse(body) as typeof rows;
    } catch {
      continue;
    }
    for (const r of rows) {
      const m = LABEL.exec(r.url ?? '');
      if (m?.[1]) add(m[1], r.company_name ?? '');
    }
  }
  const inv = await text(INVENTORY);
  if (inv) {
    for (const line of inv.split('\n').slice(1)) {
      const m = LABEL.exec(line) ?? /(?:^|,)([a-z0-9][a-z0-9-]{0,62})\.icims\.com/i.exec(line);
      if (m?.[1]) add(m[1], line.split(',')[0] ?? '');
    }
  }
  return out;
}

/** `careers-gdms` → "Gdms" is wrong, so prefer the list's company name; fall back to the label. */
function companyName(c: Candidate): string {
  if (c.company) return c.company;
  return c.label.replace(/^(careers?|jobs?|external|university|uscareers|careersus|careersen|career)-?/, '').replace(/-/g, ' ').trim() || c.label;
}

async function robotsBlocksAll(label: string): Promise<boolean> {
  const body = await text(`https://${label}.icims.com/robots.txt`);
  if (!body) return false;
  // Only the `*` group matters for us (WalkPathBot has no group on these portals).
  const lines = body.split('\n').map((l) => l.trim().toLowerCase());
  let inStar = false;
  for (const l of lines) {
    if (l.startsWith('user-agent:')) inStar = l.slice(11).trim() === '*';
    else if (inStar && /^disallow:\s*\/\s*$/.test(l)) return true;
  }
  return false;
}

async function main(): Promise<void> {
  const limit = arg('limit', Number.MAX_SAFE_INTEGER);
  const concurrency = arg('concurrency', 8);
  const existing = new Map<string, Board>();
  try {
    for (const b of parseBoardsCsv(await readFile(OUT, 'utf8'))) existing.set(b.board_key, b);
  } catch {
    // first run
  }
  const all = [...(await candidates()).values()].sort((a, b) => b.hits - a.hits || a.label.localeCompare(b.label)).slice(0, limit);
  console.log(`candidates=${all.length} existing=${existing.size}`);
  const today = new Date().toISOString().slice(0, 10);
  const rows: Board[] = [];
  const counts = { active: 0, drop: 0, needs_refingerprint: 0, disabled: 0 };
  let next = 0;
  const worker = async () => {
    while (next < all.length) {
      const c = all[next]!;
      next += 1;
      const probe = await probeBoard({ ats: 'icims', boardKey: c.label });
      let status: Board['status'] | 'drop' = probe.verdict === 'active' ? 'active' : probe.verdict === 'drop' ? 'drop' : 'needs_refingerprint';
      if (status === 'active' && (await robotsBlocksAll(c.label))) status = 'disabled';
      counts[status === 'drop' ? 'drop' : status] += 1;
      console.log(`${c.label} http=${probe.status} ${status}`);
      if (status === 'drop') continue;
      const prev = existing.get(c.label);
      rows.push({
        company_slug: prev?.company_slug ?? slugify(companyName(c)) ?? c.label,
        company_name: prev?.company_name ?? companyName(c),
        domain: prev?.domain ?? '',
        ats: 'icims',
        board_key: c.label,
        careers_url: `https://${c.label}.icims.com/jobs/search?ss=1`,
        added_at: prev?.added_at ?? today,
        status,
      });
      await new Promise((r) => setTimeout(r, 2_000));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  rows.sort((a, b) => a.board_key.localeCompare(b.board_key));
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, serializeBoards(rows));
  console.log(`wrote ${rows.length} rows to registry/seed/icims.csv (header: ${BOARDS_CSV_HEADER.join(',')})`);
  console.log(`active=${counts.active} disabled(robots)=${counts.disabled} needs_refingerprint=${counts.needs_refingerprint} dropped=${counts.drop}`);
}

await main();
