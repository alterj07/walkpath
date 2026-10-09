/**
 * One-off recorder for SmartRecruiters fixtures (maintainer tool, not part of the pipeline).
 *
 *   node packages/pipeline/test/fixtures/smartrecruiters/record.ts list <company>...
 *   node packages/pipeline/test/fixtures/smartrecruiters/record.ts detail <company> <postingId>
 *
 * Writes `list-<company>.json` (trimmed to 5 postings, intern postings first, totalFound set to
 * the kept count) or `detail-<postingId>.json` next to this file. Public postings answer without
 * a key. Companies used for the committed fixtures: BoschGroup, WesternDigital, LLNL (lists) and
 * BoschGroup/744000154435119, BoschGroup/744000154384809 (details), recorded 2026-10-09.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const UA = 'WalkPathBot/1.0 (+https://github.com/alterj07/walkpath)';
const API = 'https://api.smartrecruiters.com/v1/companies';
const isIntern = (t: string) => /\b(intern|internship|co-?op)\b/i.test(t);

interface Posting {
  name: string;
}
interface ListPayload {
  offset: number;
  limit: number;
  totalFound: number;
  content: Posting[];
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.json();
}

async function recordList(company: string): Promise<void> {
  const payload = (await getJson(`${API}/${encodeURIComponent(company)}/postings?limit=100&offset=0`)) as ListPayload;
  const interns = payload.content.filter((p) => isIntern(p.name));
  const rest = payload.content.filter((p) => !isIntern(p.name));
  const keep = [...interns, ...rest].slice(0, 5);
  const out: ListPayload = { offset: payload.offset, limit: payload.limit, totalFound: keep.length, content: keep };
  await writeFile(join(here, `list-${company}.json`), `${JSON.stringify(out, null, 1)}\n`);
  console.log(`list-${company}.json: ${keep.length} postings`);
}

async function recordDetail(company: string, postingId: string): Promise<void> {
  const payload = await getJson(`${API}/${encodeURIComponent(company)}/postings/${encodeURIComponent(postingId)}`);
  await writeFile(join(here, `detail-${postingId}.json`), `${JSON.stringify(payload, null, 1)}\n`);
  console.log(`detail-${postingId}.json`);
}

const [mode, ...args] = process.argv.slice(2);
if (mode === 'list' && args.length > 0) {
  for (const company of args) await recordList(company);
} else if (mode === 'detail' && args.length === 2) {
  await recordDetail(args[0]!, args[1]!);
} else {
  console.error('usage: record.ts list <company>... | detail <company> <postingId>');
  process.exit(2);
}
