import { FAMILY_LABELS, type RoleFamily } from '../schema/common.ts';
import type { JobRecord } from '../schema/job.ts';
import type { PagesEntry } from './formats.ts';

/** The pre-rendered SEO category pages (plan 5.5): 7 families × {all, season, remote}, top states, top companies. */
export const PAGES_TOP_STATES = 25;
export const PAGES_TOP_COMPANIES = 15;
export const PAGES_FEATURED_SEASON = 'Summer 2027';

const US_STATE_NAMES: Readonly<Record<string, string>> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'Washington, DC', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

export function familySlug(family: RoleFamily): string {
  return family.replace(/_/g, '-');
}

function seasonSlug(season: string): string {
  return season.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/** Build pages.json from the open records. Deterministic: ties break alphabetically. */
export function buildPagesList(records: readonly JobRecord[], featuredSeason = PAGES_FEATURED_SEASON): PagesEntry[] {
  const open = records.filter((r) => r.closed_at === null);
  const pages: PagesEntry[] = [];
  for (const family of Object.keys(FAMILY_LABELS) as RoleFamily[]) {
    const label = FAMILY_LABELS[family];
    const slug = familySlug(family);
    pages.push({ slug, title: `${label} internships`, kind: 'family', filter: { family } });
    pages.push({
      slug: `${slug}-${seasonSlug(featuredSeason)}`,
      title: `${label} internships for ${featuredSeason}`,
      kind: 'family_season',
      filter: { family, season: featuredSeason },
    });
    pages.push({ slug: `${slug}-remote`, title: `Remote ${label} internships`, kind: 'family_remote', filter: { family, remote: true } });
    pages.push({ slug: `new-grad-${slug}`, title: `New grad ${label} jobs`, kind: 'newgrad_family', filter: { family, kind: 'new_grad' } });
  }

  const byState = new Map<string, number>();
  const byCompany = new Map<string, { name: string; count: number }>();
  for (const r of open) {
    if (r.location.state && US_STATE_NAMES[r.location.state]) byState.set(r.location.state, (byState.get(r.location.state) ?? 0) + 1);
    const c = byCompany.get(r.company.slug);
    if (c) c.count += 1;
    else byCompany.set(r.company.slug, { name: r.company.name, count: 1 });
  }
  const topStates = [...byState.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, PAGES_TOP_STATES);
  for (const [state] of topStates) {
    pages.push({
      slug: `state-${state.toLowerCase()}`,
      title: `Tech internships in ${US_STATE_NAMES[state] ?? state}`,
      kind: 'state',
      filter: { state },
    });
  }
  const topCompanies = [...byCompany.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, PAGES_TOP_COMPANIES);
  for (const [slug, { name }] of topCompanies) {
    pages.push({ slug: `company-${slug}`, title: `${name} internships`, kind: 'company', filter: { slug } });
  }
  return pages;
}
