/**
 * Week-1 experiment 2 (plan 12.3): how fast can we page Workday tenants from a GitHub
 * Actions runner before a tenant blocks or drops pages?
 *
 *   node packages/pipeline/scripts/workday-probe.ts [--tenants 20] [--pages 5] [--delays 1000,2000,5000]
 *
 * For each delay, picks N active Workday boards from registry/boards.csv (deterministic
 * order), pages the cxs list endpoint `pages` times at that spacing with a plain fetch and
 * our fixed User-Agent, and prints ONE line per request: delay, board, offset, HTTP status,
 * postings-on-page, total, elapsed ms. Never prints bodies or headers. A 403, a Cloudflare
 * challenge (HTML body on a JSON endpoint → "challenge"), or an empty page before `total`
 * is the signal to look for. Stops a tenant at its first 403.
 *
 * The output is meant to be pasted into docs/workday.md to set WORKDAY_POLICY.minDelayMs.
 */
import { BOT_USER_AGENT } from '../src/http/client.ts';
import { loadBoards } from '../src/registry/boards.ts';

interface Args {
  tenants: number;
  pages: number;
  delays: number[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { tenants: 20, pages: 5, delays: [1000, 2000, 5000] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--tenants' && value) args.tenants = Number(value);
    if (flag === '--pages' && value) args.pages = Number(value);
    if (flag === '--delays' && value) args.delays = value.split(',').map(Number);
  }
  return args;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface PageResult {
  status: number;
  count: number | null;
  total: number | null;
  kind: 'ok' | 'empty' | 'challenge' | 'blocked' | 'error';
  ms: number;
}

async function probePage(url: string, offset: number): Promise<PageResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'user-agent': BOT_USER_AGENT, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: '' }),
      signal: controller.signal,
      redirect: 'manual',
    });
    const ms = Date.now() - started;
    if (res.status === 403 || res.status === 429) return { status: res.status, count: null, total: null, kind: 'blocked', ms };
    const text = await res.text();
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('json')) return { status: res.status, count: null, total: null, kind: 'challenge', ms };
    try {
      const data = JSON.parse(text) as { total?: number; jobPostings?: unknown[] };
      const count = Array.isArray(data.jobPostings) ? data.jobPostings.length : null;
      const total = typeof data.total === 'number' ? data.total : null;
      const kind = count === 0 && total !== null && offset < total ? 'empty' : 'ok';
      return { status: res.status, count, total, kind, ms };
    } catch {
      return { status: res.status, count: null, total: null, kind: 'challenge', ms };
    }
  } catch {
    return { status: 0, count: null, total: null, kind: 'error', ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

const args = parseArgs(process.argv.slice(2));
const boards = (await loadBoards('registry/boards.csv')).filter((b) => b.ats === 'workday' && b.status === 'active');
const picked = boards.slice(0, args.tenants);
console.log(`probing ${picked.length} tenants × ${args.pages} pages at delays ${args.delays.join(',')} ms`);
console.log('delay_ms\tboard\toffset\tstatus\tkind\tcount\ttotal\telapsed_ms');

const summary: Record<string, Record<string, number>> = {};
for (const delay of args.delays) {
  summary[String(delay)] = {};
  for (const board of picked) {
    const [tenant, site] = board.board_key.split('/');
    const url = `https://${tenant}.wd${board.wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`;
    for (let page = 0; page < args.pages; page += 1) {
      const offset = page * 20;
      const r = await probePage(url, offset);
      console.log([delay, board.board_key, offset, r.status, r.kind, r.count ?? '-', r.total ?? '-', r.ms].join('\t'));
      const bucket = summary[String(delay)]!;
      bucket[r.kind] = (bucket[r.kind] ?? 0) + 1;
      if (r.kind === 'blocked') break;
      if (r.total !== null && offset + 20 >= r.total) break;
      await sleep(delay);
    }
    await sleep(delay);
  }
}

console.log('\nsummary (requests by outcome):');
for (const [delay, counts] of Object.entries(summary)) {
  console.log(`  ${delay} ms: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
}
