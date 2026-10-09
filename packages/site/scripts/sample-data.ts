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

// Full records for the first few rows so /job/<id> and /company/<slug> render locally.
const sampleDescription = (title: string, company: string) =>
  `<p>${company} is looking for a ${title} to join a small team shipping real features.</p>` +
  '<h3>What you will do</h3><ul><li>Design, build and test production code</li><li>Pair with senior engineers</li>' +
  '<li>Present your project at the end of the summer</li></ul>' +
  '<h3>What we look for</h3><ul><li>Currently pursuing a BS/MS in CS or a related field</li>' +
  '<li>Experience with one of Python, Go, TypeScript or C++</li><li>Curiosity and clear written communication</li></ul>' +
  '<p>Pay range: $42.00 to $55.00 USD hourly. We do not sponsor work visas for this role.</p>' +
  '<p>Equal opportunity employer. Accommodation requests are welcome.</p>';

const buckets: Record<string, Record<string, unknown>> = {};
rows.slice(0, 8).forEach((r, i) => {
  const record = {
    id: r.id,
    title: r.title,
    title_raw: r.title,
    company: { slug: r.slug, name: r.company, domain: r.domain },
    location: {
      raw: r.city ? `${r.city}, ${r.state}` : 'Remote - United States',
      city: r.city, state: r.state, country: 'US', arrangement: r.arrangement,
      others: r.others ? ['Austin, TX', 'Seattle, WA', 'New York, NY'] : [],
    },
    source: { ats: r.ats, board: r.slug, external_id: `SAMPLE-${1000 + i}` },
    apply_url: `https://${r.domain}/careers/${r.id}`,
    apply_url_downgraded: false,
    posted_at: r.posted_at,
    posted_at_source: r.ats === 'workday' ? 'WORKDAY_TEXT' : 'ATS_FIELD',
    first_seen_at: r.first_seen_at,
    last_seen_at: new Date(SAMPLE_DATE).toISOString(),
    closed_at: i === 7 ? new Date(SAMPLE_DATE - 3_600_000).toISOString() : null,
    employment_type: /co-op/i.test(r.title) ? 'co_op' : 'internship',
    role_family: r.family,
    season: r.season,
    salary: r.has_salary ? { min: 42, max: 55, currency: 'USD', period: 'hour' } : null,
    citizenship_required: r.citizenship_required,
    sponsorship: i % 2 === 0 ? 'no' : 'unknown',
    grad_years: i % 3 === 0 ? [2027, 2028] : [],
    summary: i % 4 === 3 ? null : {
      text: `${r.company} wants a ${r.title.replace(/,.*$/, '').toLowerCase()} to ship production code with a small team. Students pursuing a CS degree with one systems language are a fit.`,
      responsibilities: ['Design, build and test production code', 'Pair with senior engineers', 'Present a project at the end of the term'],
      qualifications: ['Pursuing a BS/MS in CS or related', 'One of Python, Go, TypeScript or C++', 'Clear written communication'],
      must_have_skills: ['Python', 'Git'],
      nice_to_have_skills: ['Go', 'TypeScript'],
      model: 'mistral/mistral-small-latest',
      generated_at: new Date(Date.parse(r.first_seen_at) + 120_000).toISOString(),
    },
    description_html: sampleDescription(r.title, r.company),
    content_hash: id(`hash|${r.id}`).padEnd(32, '0'),
  };
  (buckets[r.id.slice(0, 2)] ??= {})[r.id] = record;
});

const companiesFile: Record<string, unknown> = {};
for (const [name, domain, ats] of companies) {
  const slug = domain.replace(/\.test$/, '').replace(/[^a-z0-9]+/g, '-');
  companiesFile[slug] = {
    name, domain, blurb: `${name} is a fictional company used only for local development samples.`,
    ats: [ats], careers_url: `https://${domain}/careers`, open_count: rows.filter((r) => r.slug === slug).length,
  };
}

mkdirSync(join(root, 'index'), { recursive: true });
mkdirSync(join(root, 'jobs'), { recursive: true });
writeFileSync(join(root, 'index', 'latest.json'), JSON.stringify(index, null, 1));
writeFileSync(join(root, 'meta.json'), JSON.stringify(meta, null, 1));
writeFileSync(join(root, 'companies.json'), JSON.stringify(companiesFile, null, 1));
for (const [bucket, records] of Object.entries(buckets)) {
  writeFileSync(join(root, 'jobs', `${bucket}.json`), JSON.stringify(records, null, 1));
}

// index/all.json: every open row (the samples are all open) for the explore
// table's 30-day window and for the build-time category pages.
writeFileSync(join(root, 'index', 'all.json'), JSON.stringify(index, null, 1));

// pages.json: the category pages the publish job would emit (plan 2.5),
// sampled so every kind is represented.
const familyLabels: Record<string, string> = {
  software_engineering: 'Software Engineering',
  data_ml_ai: 'Data / ML / AI',
  it_cloud_security: 'IT / Cloud / Security',
  product: 'Product',
  ux_design: 'UX / Design',
  hardware_embedded: 'Hardware / Embedded / EE',
  quant_research: 'Quant / Research',
};
const familySlug = (f: string) => f.replace(/_/g, '-');
const pages: Array<{ slug: string; title: string; kind: string; filter: Record<string, unknown> }> = [];
for (const [family, label] of Object.entries(familyLabels)) {
  pages.push({ slug: familySlug(family), title: label, kind: 'family', filter: { family } });
}
for (const family of ['software_engineering', 'data_ml_ai']) {
  pages.push({
    slug: `${familySlug(family)}-summer-2027`,
    title: `${familyLabels[family]} · Summer 2027`,
    kind: 'family_season',
    filter: { family, season: 'Summer 2027' },
  });
  pages.push({
    slug: `${familySlug(family)}-remote`,
    title: `${familyLabels[family]} · Remote`,
    kind: 'family_remote',
    filter: { family, remote: true },
  });
}
for (const [state, name] of [['CA', 'California'], ['TX', 'Texas'], ['NY', 'New York']] as const) {
  pages.push({ slug: `state-${state.toLowerCase()}`, title: name, kind: 'state', filter: { state } });
}
for (const [company, domain] of companies.slice(0, 2)) {
  const slug = domain.replace(/\.test$/, '').replace(/[^a-z0-9]+/g, '-');
  pages.push({ slug: `company-${slug}`, title: company, kind: 'company', filter: { slug } });
}
writeFileSync(join(root, 'pages.json'), JSON.stringify(pages, null, 1));
console.log(`wrote ${rows.length} sample rows, ${Object.keys(buckets).length} job buckets, companies.json, meta.json, index/all.json and ${pages.length} pages to ${root}`);
