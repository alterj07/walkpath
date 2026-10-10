import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IndexRow } from '../src/lib/data.ts';
import {
  describePage,
  exploreHref,
  isPagesEntry,
  itemListJsonLd,
  loadBuildData,
  pageStats,
  parsePages,
  rowsForPage,
  shouldNoindex,
  siblingLinks,
} from '../src/lib/seo.ts';
import type { PagesEntry } from '../src/lib/seo.ts';

const GEN = '2026-10-09T18:00:00Z';
const H = 3_600_000;

function row(over: Partial<IndexRow> & { id: string }): IndexRow {
  return {
    title: 'Software Engineering Intern',
    company: 'Example Robotics',
    slug: 'example-robotics',
    domain: 'example-robotics.test',
    city: 'Austin',
    state: 'TX',
    arrangement: 'in_person',
    family: 'software_engineering',
    kind: 'internship',
    season: 'Summer 2027',
    posted_at: new Date(Date.parse(GEN) - 2 * H).toISOString(),
    first_seen_at: new Date(Date.parse(GEN) - 1.5 * H).toISOString(),
    ats: 'greenhouse',
    has_salary: false,
    citizenship_required: null,
    others: 0,
    ...over,
  };
}

const rows: IndexRow[] = [
  row({ id: 'a00000000001' }),
  row({ id: 'a00000000002', family: 'data_ml_ai', posted_at: new Date(Date.parse(GEN) - 10 * H).toISOString() }),
  row({ id: 'a00000000003', arrangement: 'remote', city: null, state: null, posted_at: new Date(Date.parse(GEN) - 4 * H).toISOString() }),
  row({ id: 'a00000000004', state: 'CA', city: 'San Jose', slug: 'sample-cloud', company: 'Sample Cloud Co', season: 'Fall 2026' }),
  row({ id: 'a00000000005', posted_at: new Date(Date.parse(GEN) - 30 * H).toISOString() }),
  row({ id: 'a00000000006', posted_at: new Date(Date.parse(GEN) - 6 * H).toISOString(), first_seen_at: new Date(Date.parse(GEN) - 5 * H).toISOString() }),
];

const swe: PagesEntry = { slug: 'software-engineering', title: 'Software Engineering', kind: 'family', filter: { family: 'software_engineering' } };
const sweSummer: PagesEntry = { slug: 'software-engineering-summer-2027', title: 'Software Engineering · Summer 2027', kind: 'family_season', filter: { family: 'software_engineering', season: 'Summer 2027' } };
const sweRemote: PagesEntry = { slug: 'software-engineering-remote', title: 'Software Engineering · Remote', kind: 'family_remote', filter: { family: 'software_engineering', remote: true } };
const data: PagesEntry = { slug: 'data-ml-ai', title: 'Data / ML / AI', kind: 'family', filter: { family: 'data_ml_ai' } };
const ca: PagesEntry = { slug: 'state-ca', title: 'California', kind: 'state', filter: { state: 'CA' } };
const company: PagesEntry = { slug: 'company-sample-cloud', title: 'Sample Cloud Co', kind: 'company', filter: { slug: 'sample-cloud' } };
const pages = [swe, sweSummer, sweRemote, data, ca, company];

describe('rowsForPage', () => {
  it('filters by family and sorts newest first', () => {
    const out = rowsForPage(rows, swe);
    expect(out.map((r) => r.id)).toEqual(['a00000000001', 'a00000000004', 'a00000000003', 'a00000000006', 'a00000000005']);
  });
  it('filters by season, remote, state and company slug', () => {
    expect(rowsForPage(rows, sweSummer).map((r) => r.id)).toEqual(['a00000000001', 'a00000000003', 'a00000000006', 'a00000000005']);
    expect(rowsForPage(rows, sweRemote).map((r) => r.id)).toEqual(['a00000000003']);
    expect(rowsForPage(rows, ca).map((r) => r.id)).toEqual(['a00000000004']);
    expect(rowsForPage(rows, company).map((r) => r.id)).toEqual(['a00000000004']);
    expect(rowsForPage(rows, data).map((r) => r.id)).toEqual(['a00000000002']);
  });
  it('does not mutate the input', () => {
    const copy = [...rows];
    rowsForPage(rows, swe);
    expect(rows).toEqual(copy);
  });
});

describe('pageStats', () => {
  it('counts open rows, distinct companies and the median age in hours', () => {
    const s = pageStats(rowsForPage(rows, swe), GEN);
    expect(s.open).toBe(5);
    expect(s.companies).toBe(2);
    // ages: 2, 2, 4, 6, 30 h → median 4
    expect(s.medianHoursSincePosted).toBe(4);
  });
  it('averages the two middle values for an even count and handles empty', () => {
    const s = pageStats(rowsForPage(rows, sweSummer), GEN);
    // ages: 2, 4, 6, 30 → (4 + 6) / 2 = 5
    expect(s.medianHoursSincePosted).toBe(5);
    expect(pageStats([], GEN)).toEqual({ open: 0, companies: 0, medianHoursSincePosted: null });
  });
  it('ignores future-dated rows for the median', () => {
    const future = row({ id: 'a00000000009', posted_at: new Date(Date.parse(GEN) + H).toISOString() });
    expect(pageStats([future], GEN).medianHoursSincePosted).toBeNull();
    expect(pageStats([future], GEN).open).toBe(1);
  });
});

describe('shouldNoindex', () => {
  it('is true below five open jobs', () => {
    expect(shouldNoindex(rows.slice(0, 4))).toBe(true);
    expect(shouldNoindex(rows.slice(0, 5))).toBe(false);
    expect(shouldNoindex([])).toBe(true);
  });
});

describe('siblingLinks', () => {
  it('returns same-kind pages and same-family pages, never itself', () => {
    const s = siblingLinks(sweSummer, pages).map((p) => p.slug);
    expect(s).toEqual(['software-engineering', 'software-engineering-remote']);
    const f = siblingLinks(swe, pages).map((p) => p.slug);
    expect(f).toEqual(['software-engineering-summer-2027', 'software-engineering-remote', 'data-ml-ai']);
    expect(siblingLinks(ca, pages)).toEqual([]);
  });
});

describe('exploreHref', () => {
  it('encodes the same filter as a 30-day explore URL', () => {
    expect(exploreHref(swe)).toBe('/?window=30d&family=software_engineering');
    expect(exploreHref(sweSummer)).toBe('/?window=30d&family=software_engineering&season=Summer+2027');
    expect(exploreHref(sweRemote)).toBe('/?window=30d&family=software_engineering&arr=remote');
    expect(exploreHref(ca)).toBe('/?window=30d&state=CA');
    expect(exploreHref(company)).toBe('/?window=30d&company=Sample+Cloud+Co');
  });
});

describe('itemListJsonLd', () => {
  it('emits an ItemList of job page links with "<" escaped', () => {
    const hostile = row({ id: 'a00000000007', title: '</script><script>alert(1)</script>', company: 'A & B' });
    const json = itemListJsonLd(swe, [hostile, ...rows.slice(0, 1)], 'https://walkpath.pages.dev/');
    expect(json).not.toContain('</script');
    expect(json).toContain('\\u003c/script');
    const doc = JSON.parse(json) as {
      '@type': string;
      url: string;
      numberOfItems: number;
      itemListElement: Array<{ position: number; url: string; name: string }>;
    };
    expect(doc['@type']).toBe('ItemList');
    expect(doc.url).toBe('https://walkpath.pages.dev/internships/software-engineering');
    expect(doc.numberOfItems).toBe(2);
    expect(doc.itemListElement[0]).toEqual({
      '@type': 'ListItem',
      position: 1,
      url: 'https://walkpath.pages.dev/job/a00000000007',
      name: '</script><script>alert(1)</script> at A & B',
    });
    expect(doc.itemListElement.every((e) => e.url.startsWith('https://walkpath.pages.dev/job/'))).toBe(true);
  });
  it('caps the list at 50 items while reporting the full count', () => {
    const many = Array.from({ length: 60 }, (_, i) => row({ id: `b${String(i).padStart(11, '0')}` }));
    const doc = JSON.parse(itemListJsonLd(swe, many, 'https://x.test')) as { numberOfItems: number; itemListElement: unknown[] };
    expect(doc.numberOfItems).toBe(60);
    expect(doc.itemListElement).toHaveLength(50);
  });
});

describe('describePage', () => {
  it('reads naturally', () => {
    expect(describePage(swe, { open: 5, companies: 2, medianHoursSincePosted: 4 })).toBe(
      "Software Engineering internships in the US: 5 open internships, 2 companies, median 4 h since posting. Polled hourly from employers' own job boards.",
    );
    expect(describePage(ca, { open: 1, companies: 1, medianHoursSincePosted: null })).toBe(
      "California internships in the US: 1 open internship, 1 company. Polled hourly from employers' own job boards.",
    );
  });
});

describe('pages.json guards', () => {
  it('accepts valid entries and drops bad or duplicate ones', () => {
    const input = [
      swe,
      { ...swe },
      { slug: 'Bad Slug', title: 'x', kind: 'family', filter: {} },
      { slug: 'ok', title: 'x', kind: 'weird', filter: {} },
      { slug: 'ok2', title: 'x', kind: 'family', filter: { family: 'evil' } },
      { slug: 'ok3', title: 'x', kind: 'state', filter: { state: 'ZZ' } },
      { slug: 'ok4', title: 'x', kind: 'family_season', filter: { family: 'product', season: 'Summer 2027', extra: 1 } },
      null,
      'str',
    ];
    const out = parsePages(input);
    expect(out.map((p) => p.slug)).toEqual(['software-engineering', 'ok4']);
    expect(out[1]?.filter).toEqual({ family: 'product', season: 'Summer 2027' });
    expect(isPagesEntry({ slug: 'a', title: 't', kind: 'company', filter: { slug: 'b' } })).toBe(true);
    expect(parsePages({ not: 'array' })).toEqual([]);
  });
});

describe('loadBuildData', () => {
  it('reads pages.json and index/all.json from a directory and tolerates missing files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'walkpath-seo-'));
    mkdirSync(join(dir, 'index'), { recursive: true });
    writeFileSync(join(dir, 'pages.json'), JSON.stringify([swe, { bad: true }]));
    writeFileSync(join(dir, 'index', 'all.json'), JSON.stringify({ generated_at: GEN, rows: [rows[0], { junk: 1 }] }));
    const d = loadBuildData(dir);
    expect(d.pages).toHaveLength(1);
    expect(d.rows).toHaveLength(1);
    expect(d.generatedAt).toBe(GEN);
    const empty = loadBuildData(join(dir, 'missing'));
    expect(empty).toEqual({ pages: [], rows: [], generatedAt: '' });
  });
});
