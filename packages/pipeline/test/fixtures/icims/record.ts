/**
 * Recorder for the iCIMS fixtures (not a test; not matched by vitest).
 *   node packages/pipeline/test/fixtures/icims/record.ts
 * Fetches the mobile search page (page 0 and 1) and one job page per portal, 2 s apart, and writes
 * trimmed copies: the first N job cards of each search page and only the JSON-LD block of each job
 * page. Portals recorded 2026-10-10: careers-gdms, careers-sig, careers-peraton.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UA = 'WalkPathBot/1.0 (+https://github.com/alterj07/walkpath)';
const dir = dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function get(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'manual', signal: AbortSignal.timeout(25_000) });
  const body = await res.text();
  await sleep(2_000);
  return { status: res.status, body };
}

function trimSearch(html: string, n: number): string {
  const starts = [...html.matchAll(/<li\b[^>]*class="[^"]*iCIMS_JobCardItem/g)].map((m) => m.index ?? 0);
  if (starts.length === 0) throw new Error('no cards');
  const listStart = html.lastIndexOf('<ul class="container-fluid iCIMS_JobsTable">', starts[0]);
  const head = html.slice(listStart, starts[0]);
  const end = html.indexOf('</ul>', starts[starts.length - 1] ?? 0);
  const cards = starts
    .slice(0, n)
    .map((s, i) => html.slice(s, i + 1 < starts.length ? starts[i + 1] : end))
    .join('');
  return `<!doctype html><html><body>\n<!-- Recorded from a live iCIMS portal, trimmed to ${n} cards; descriptions shortened. -->\n${head}${cards}</ul>\n</body></html>\n`;
}

function trimJob(html: string): string {
  const ld = /<script[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>/.exec(html)?.[0];
  if (!ld) throw new Error('no json-ld');
  const title = /<title>[^<]*<\/title>/.exec(html)?.[0] ?? '';
  return `<!doctype html><html><head>${title}\n${ld}\n</head><body><div class="iCIMS_MainWrapper"><!-- trimmed job page --></div></body></html>\n`;
}

const targets: Array<[string, string, string, number]> = [
  ['careers-gdms', 'gdms-search-p0.html', 'https://careers-gdms.icims.com/jobs/search?pr=0&mobile=true&needsRedirect=false', 3],
  ['careers-gdms', 'gdms-search-p1.html', 'https://careers-gdms.icims.com/jobs/search?pr=1&mobile=true&needsRedirect=false', 3],
  ['careers-sig', 'sig-search.html', 'https://careers-sig.icims.com/jobs/search?pr=0&mobile=true&needsRedirect=false', 2],
  ['careers-peraton', 'peraton-search.html', 'https://careers-peraton.icims.com/jobs/search?pr=0&mobile=true&needsRedirect=false', 2],
];
const jobs: Array<[string, string]> = [
  ['gdms-job-72997.html', 'https://careers-gdms.icims.com/jobs/72997/job?in_iframe=1'],
  ['sig-job-10966.html', 'https://careers-sig.icims.com/jobs/10966/job?in_iframe=1'],
];

for (const [, file, url, n] of targets) {
  const { status, body } = await get(url);
  console.log(file, status, body.length);
  if (status === 200) writeFileSync(join(dir, file), trimSearch(body, n));
}
for (const [file, url] of jobs) {
  const { status, body } = await get(url);
  console.log(file, status, body.length);
  if (status === 200) writeFileSync(join(dir, file), trimJob(body));
}
