/**
 * One-off recorder for Workday fixtures (maintainer tool, not part of the pipeline).
 *
 *   node packages/pipeline/test/fixtures/workday/record.ts list <tenant> <wd> <site>
 *   node packages/pipeline/test/fixtures/workday/record.ts detail <tenant> <wd> <site> <externalPath>
 *
 * Writes `<tenant>-list.json` (first page trimmed to 5 postings, intern titles first) or
 * `<tenant>-detail.json` (jobDescription cut to 1,500 chars, questionnaire ids and
 * similarJobs dropped) next to this file. Requests are spaced 2 s apart.
 * Tenants used for the committed fixtures (recorded 2026-10-09):
 *   nvidia wd5 NVIDIAExternalCareerSite, boeing wd1 EXTERNAL_CAREERS, cisco wd5 cisco_careers
 *   details: nvidia CPU-Compiler-Intern---2027_JR2027251, boeing
 *   Engineering-Intern---Summer-2027_JR2026520518, cisco Software-Engineer_2024896.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { WorkdayDetailResponseSchema, WorkdayListSchema } from '../../../src/adapters/workday.ts';

const here = dirname(fileURLToPath(import.meta.url));
const UA = 'WalkPathBot/1.0 (+https://github.com/alterj07/walkpath)';
const isIntern = (t: string) => /\b(intern|internship|co-?op)\b/i.test(t);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Recorded through the adapter's own schemas, so a fixture can never hold a shape the adapter rejects.
const ListSchema = WorkdayListSchema;
const DetailSchema = WorkdayDetailResponseSchema.extend({ hiringOrganization: z.object({ name: z.string().nullish() }).nullish() });

function host(tenant: string, wd: string): string {
  return `https://${tenant}.wd${wd}.myworkdayjobs.com`;
}

async function recordList(tenant: string, wd: string, site: string): Promise<void> {
  const res = await fetch(`${host(tenant, wd)}/wday/cxs/${tenant}/${site}/jobs`, {
    method: 'POST',
    headers: { 'user-agent': UA, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: '' }),
  });
  if (!res.ok) throw new Error(`${res.status} for ${tenant} list`);
  const data = ListSchema.parse(await res.json());
  const postings = data.jobPostings ?? [];
  const interns = postings.filter((j) => isIntern(j.title));
  const others = postings.filter((j) => !isIntern(j.title));
  const pick = [...interns, ...others].slice(0, 5);
  const out = { total: data.total, jobPostings: pick, facets: [], userAuthenticated: false };
  await writeFile(join(here, `${tenant}-list.json`), `${JSON.stringify(out, null, 2)}\n`);
  console.log(tenant, 'list ->', pick.length, 'of', postings.length, 'on page; total', data.total);
}

async function recordDetail(tenant: string, wd: string, site: string, externalPath: string): Promise<void> {
  const res = await fetch(`${host(tenant, wd)}/wday/cxs/${tenant}/${site}${externalPath}`, {
    headers: { 'user-agent': UA, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`${res.status} for ${tenant} detail`);
  // The schema strips questionnaire ids and other keys the adapter does not read.
  const data = DetailSchema.parse(await res.json());
  const info = { ...data.jobPostingInfo };
  if (typeof info.jobDescription === 'string') info.jobDescription = info.jobDescription.slice(0, 1500);
  const out = { jobPostingInfo: info, hiringOrganization: data.hiringOrganization ?? null, similarJobs: [], userAuthenticated: false };
  await writeFile(join(here, `${tenant}-detail.json`), `${JSON.stringify(out, null, 2)}\n`);
  console.log(tenant, 'detail ->', info.title);
}

const [mode, tenant, wd, site, externalPath] = process.argv.slice(2);
if (mode === 'list' && tenant && wd && site) {
  await recordList(tenant, wd, site);
} else if (mode === 'detail' && tenant && wd && site && externalPath) {
  await sleep(2000);
  await recordDetail(tenant, wd, site, externalPath);
} else {
  console.error('usage: record.ts list <tenant> <wd> <site> | detail <tenant> <wd> <site> <externalPath>');
  process.exit(1);
}
