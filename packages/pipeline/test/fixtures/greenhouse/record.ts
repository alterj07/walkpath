/**
 * One-off recorder for Greenhouse fixtures (maintainer tool, not part of the pipeline).
 *
 *   node packages/pipeline/test/fixtures/greenhouse/record.ts list <board>...
 *   node packages/pipeline/test/fixtures/greenhouse/record.ts detail <board> <jobId>
 *
 * Writes `<board>-list.json` (trimmed to 5 jobs, intern postings first) or
 * `<board>-<jobId>-detail.json` (content cut to 1,500 chars) next to this file.
 * Boards used for the committed fixtures: figma, stripe, anthropic, databricks, duolingo
 * (lists) and figma/6178851004, duolingo/8863967002 (details), recorded 2026-10-09.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const UA = 'WalkPathBot/1.0 (+https://github.com/alterj07/walkpath)';
const isIntern = (t: string) => /\b(intern|internship|co-?op)\b/i.test(t);

interface PayRange {
  blurb?: string | null;
}
interface RawJob {
  title: string;
  location?: { name?: string | null } | null;
  pay_input_ranges?: PayRange[] | null;
  content?: string;
  ai_disclaimer?: unknown;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.json();
}

function trimBlurbs(job: RawJob): void {
  for (const r of job.pay_input_ranges ?? []) if (typeof r.blurb === 'string') r.blurb = r.blurb.slice(0, 80);
}

async function recordList(board: string): Promise<void> {
  const data = (await getJson(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs?pay_transparency=true`)) as { jobs: RawJob[] };
  const interns = data.jobs.filter((j) => isIntern(j.title));
  const others = data.jobs.filter((j) => !isIntern(j.title));
  const pick: RawJob[] = [];
  const push = (j: RawJob | undefined) => {
    if (j && !pick.includes(j) && pick.length < 5) pick.push(j);
  };
  for (const j of interns.slice(0, 3)) push(j);
  push(others.find((j) => j.pay_input_ranges?.length));
  push(others.find((j) => /[;|•]/.test(j.location?.name ?? '')));
  for (const j of others) push(j);
  for (const j of pick) trimBlurbs(j);
  await writeFile(join(here, `${board}-list.json`), `${JSON.stringify({ jobs: pick, meta: { total: pick.length } }, null, 2)}\n`);
  console.log(board, '->', pick.length, 'jobs of', data.jobs.length);
}

async function recordDetail(board: string, id: string): Promise<void> {
  const job = (await getJson(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}?questions=false&pay_transparency=true`)) as RawJob;
  if (typeof job.content === 'string') job.content = job.content.slice(0, 1500);
  delete job.ai_disclaimer;
  trimBlurbs(job);
  await writeFile(join(here, `${board}-${id}-detail.json`), `${JSON.stringify(job, null, 2)}\n`);
  console.log(board, id, '->', job.title);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'list') {
  for (const b of rest) await recordList(b);
} else if (mode === 'detail' && rest.length === 2) {
  await recordDetail(rest[0]!, rest[1]!);
} else {
  console.error('usage: record.ts list <board>... | detail <board> <jobId>');
  process.exit(1);
}
