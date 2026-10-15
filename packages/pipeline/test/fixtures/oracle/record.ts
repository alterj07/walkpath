/**
 * One-off recorder for Oracle Cloud HCM fixtures (maintainer tool, not part of the pipeline).
 *
 *   node packages/pipeline/test/fixtures/oracle/record.ts list <host>/<site> <name>
 *   node packages/pipeline/test/fixtures/oracle/record.ts detail <host>/<site> <id> <name>
 *
 * Writes `<name>-list.json` (first page trimmed to 5 requisitions, intern titles first) or
 * `<name>-<id>-detail.json` (description fields cut to 1,500 chars) next to this file.
 * Sites used for the committed fixtures (recorded 2026-10-10):
 *   eeho.fa.us2.oraclecloud.com/CX_45001 (Oracle), fa-exki-saasfaprod1.fa.ocs.oraclecloud.com/CX_1
 *   (Fanatics), egug.fa.us2.oraclecloud.com/CX_1.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OracleDetailResponseSchema, OracleListSchema } from '../../../src/adapters/oracle.ts';

const here = dirname(fileURLToPath(import.meta.url));
const UA = 'WalkPathBot/1.0 (+https://github.com/alterj07/walkpath)';
const REST = 'hcmRestApi/resources/latest';
const isIntern = (t: string) => /\b(intern|internship|co-?op|student|graduate|new grad)\b/i.test(t);

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.json();
}

function cut(s: string | null | undefined, n: number): string | null | undefined {
  return typeof s === 'string' ? s.slice(0, n) : s;
}

async function recordList(board: string, name: string): Promise<void> {
  const [host, site] = board.split('/');
  if (!host || !site) throw new Error('board must be host/site');
  const finder = `findReqs;siteNumber=${site},limit=25,offset=0,sortBy=POSTING_DATES_DESC`;
  const raw = await getJson(`https://${host}/${REST}/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations,flexFieldsFacet.values&finder=${finder}`);
  const parsed = OracleListSchema.parse(raw);
  const item = parsed.items?.[0];
  const list = item?.requisitionList ?? [];
  const interns = list.filter((j) => isIntern(j.Title));
  const others = list.filter((j) => !isIntern(j.Title));
  const pick = [...interns.slice(0, 3), ...others].slice(0, 5);
  for (const j of pick) {
    j.ShortDescriptionStr = cut(j.ShortDescriptionStr, 200);
    j.ExternalQualificationsStr = cut(j.ExternalQualificationsStr, 600);
    j.ExternalResponsibilitiesStr = cut(j.ExternalResponsibilitiesStr, 600);
  }
  const out = { items: [{ TotalJobsCount: item?.TotalJobsCount ?? pick.length, requisitionList: pick }] };
  await writeFile(join(here, `${name}-list.json`), `${JSON.stringify(out, null, 2)}\n`);
  console.log(name, '->', pick.length, 'of', item?.TotalJobsCount ?? 0, 'requisitions');
}

async function recordDetail(board: string, id: string, name: string): Promise<void> {
  const [host, site] = board.split('/');
  if (!host || !site) throw new Error('board must be host/site');
  const raw = await getJson(`https://${host}/${REST}/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=${id},siteNumber=${site}`);
  const parsed = OracleDetailResponseSchema.parse(raw);
  const d = parsed.items?.[0];
  if (!d) throw new Error('no detail item');
  d.ExternalDescriptionStr = cut(d.ExternalDescriptionStr, 1500);
  d.ExternalQualificationsStr = cut(d.ExternalQualificationsStr, 1500);
  d.ExternalResponsibilitiesStr = cut(d.ExternalResponsibilitiesStr, 1500);
  await writeFile(join(here, `${name}-${id}-detail.json`), `${JSON.stringify({ items: [{ Id: id, ...d }] }, null, 2)}\n`);
  console.log(name, id, '->', d.Title);
}

const [mode, board, a, b] = process.argv.slice(2);
if (mode === 'list' && board && a) await recordList(board, a);
else if (mode === 'detail' && board && a && b) await recordDetail(board, a, b);
else {
  console.error('usage: record.ts list <host>/<site> <name> | detail <host>/<site> <id> <name>');
  process.exit(1);
}
