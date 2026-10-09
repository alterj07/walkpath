/**
 * Writes dev sample data to public/data so the site renders without the
 * pipeline. Companies are fictional. Run: node packages/site/scripts/sample-data.ts
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_DATE = Date.parse('2026-10-09T18:00:00Z');
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');

const companies = [
  ['Example Robotics', 'example-robotics.test', 'greenhouse'],
  ['Sample Cloud Co', 'samplecloud.test', 'lever'],
  ['Placeholder Labs', 'placeholderlabs.test', 'ashby'],
  ['Demo Semiconductors', 'demosemi.test', 'workday'],
  ['Fictional Fintech', 'fictionalfintech.test', 'smartrecruiters'],
  ['Mock Mobility', 'mockmobility.test', 'workable'],
  ['Test Aerospace', 'testaerospace.test', 'workday'],
  ['Pretend Health AI', 'pretendhealth.test', 'greenhouse'],
] as const;

const locations = [
  ['San Francisco', 'CA'], ['Austin', 'TX'], ['New York', 'NY'], ['Seattle', 'WA'], ['Boston', 'MA'],
  ['Denver', 'CO'], ['Chicago', 'IL'], ['Atlanta', 'GA'], ['Raleigh', 'NC'], ['Phoenix', 'AZ'],
  [null, null],
] as const;

const titles: Array<[string, string]> = [
  ['Software Engineering Intern, Summer 2027', 'software_engineering'],
  ['Backend Developer Intern (Go)', 'software_engineering'],
  ['Frontend Engineer Intern', 'software_engineering'],
  ['iOS Engineering Intern', 'software_engineering'],
  ['Machine Learning Intern', 'data_ml_ai'],
  ['Data Science Intern, Summer 2027', 'data_ml_ai'],
  ['Applied AI Research Intern', 'data_ml_ai'],
  ['Cloud Infrastructure Intern', 'it_cloud_security'],
  ['Security Engineering Intern', 'it_cloud_security'],
  ['IT Systems Co-op, Spring 2027', 'it_cloud_security'],
  ['Product Management Intern', 'product'],
  ['Technical Program Management Intern', 'product'],
  ['Product Design Intern', 'ux_design'],
  ['UX Research Intern', 'ux_design'],
  ['Embedded Firmware Intern', 'hardware_embedded'],
  ['Electrical Engineering Intern, Summer 2027', 'hardware_embedded'],
  ['ASIC Design Verification Intern', 'hardware_embedded'],
  ['Quantitative Research Intern', 'quant_research'],
  ['Quant Developer Intern, Summer 2027', 'quant_research'],
  ['Flight Software Intern', 'hardware_embedded'],
];

const arrangements = ['in_person', 'hybrid', 'remote', 'unknown'] as const;
const seasons = ['Summer 2027', 'Summer 2027', 'Spring 2027', 'Fall 2026', null] as const;

function id(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 12);
}

const rows = [];
for (let i = 0; i < 44; i += 1) {
  const [title, family] = titles[i % titles.length]!;
  const [company, domain, ats] = companies[i % companies.length]!;
  const loc = locations[(i * 7) % locations.length]!;
  const arrangement = loc[0] === null ? 'remote' : arrangements[i % 3]!;
  // Most rows inside the last 24 h, a few spread over the previous week.
  const ageMin = i < 34 ? 7 * i + 12 : 24 * 60 + 90 * (i - 33) * 11;
  const posted = SAMPLE_DATE - ageMin * 60_000;
  const firstSeen = posted + (5 + (i % 40)) * 60_000;
  rows.push({
    id: id(`${title}|${company}|${i}`),
    title,
    company,
    slug: domain.replace(/\.test$/, '').replace(/[^a-z0-9]+/g, '-'),
    domain,
    city: loc[0],
    state: loc[1],
    arrangement,
    family,
    season: seasons[i % seasons.length],
    posted_at: new Date(posted).toISOString(),
    first_seen_at: new Date(firstSeen).toISOString(),
    ats,
    has_salary: i % 3 === 0,
    citizenship_required: i % 5 === 0 ? true : i % 7 === 0 ? null : false,
    others: i % 9 === 0 ? 3 : 0,
  });
}

const index = { generated_at: new Date(SAMPLE_DATE).toISOString(), rows };
const meta = {
  last_run_at: new Date(SAMPLE_DATE).toISOString(),
  run_id: 'sample-2026-10-09T18',
  boards: {
    greenhouse: { polled: 2140, ok: 2131, failed: 9 },
    lever: { polled: 610, ok: 607, failed: 3 },
    ashby: { polled: 905, ok: 903, failed: 2 },
    workable: { polled: 480, ok: 471, failed: 9 },
    smartrecruiters: { polled: 0, ok: 0, failed: 0 },
    workday: { polled: 320, ok: 301, failed: 19 },
  },
  jobs: { open: 3412, new: 44, closed: 18 },
  latency: { median_min: 23, p90_min: 51 },
  llm: { mistral: { requests: 44, tokens: 104_000 } },
  pending_summaries: 2,
  held_for_review: 1,
  schedule: { started_at: new Date(SAMPLE_DATE - 11 * 60_000).toISOString(), lateness_min: 2 },
};

mkdirSync(join(root, 'index'), { recursive: true });
writeFileSync(join(root, 'index', 'latest.json'), JSON.stringify(index, null, 1));
writeFileSync(join(root, 'meta.json'), JSON.stringify(meta, null, 1));
console.log(`wrote ${rows.length} sample rows and meta.json to ${root}`);
