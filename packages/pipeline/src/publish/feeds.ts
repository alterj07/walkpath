import type { JobRecord } from '../schema/job.ts';
import { FAMILY_LABELS, type RoleFamily } from '../schema/common.ts';
import { textPreview } from './sanitize.ts';

/**
 * Atom feeds (plan section 2.4). Every field is escaped; entries link to our job page,
 * never to the raw apply URL, so a posting cannot inject a destination into a reader.
 *
 * `buildFeed` and `feedTargets` expect OPEN records only (closed_at === null); the
 * publish orchestrator filters before calling them. A closed job in a feed would
 * re-alert readers to a listing they can no longer apply to.
 */

export const SAFETY_LINE =
  'Legitimate employers never ask for payment, bank details, or your SSN before an offer.';

export const FEED_MAX_ITEMS = 100;

export { FAMILY_LABELS };

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}

/** Strip characters that are illegal in XML 1.0 (control chars other than tab, LF, CR). */
function xmlSafe(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    out += ch;
  }
  return escapeXml(out);
}

export interface FeedInput {
  title: string;
  siteUrl: string;
  /** Path of this feed on the site, e.g. `/feeds/all.xml`. */
  selfPath: string;
  updated: string;
  items: readonly JobRecord[];
}

function locationLabel(r: JobRecord): string {
  const parts = [r.location.city, r.location.state].filter((p): p is string => !!p);
  const base = parts.length > 0 ? parts.join(', ') : r.location.raw || 'Location not listed';
  if (r.location.arrangement === 'remote') return `${base} (Remote)`;
  if (r.location.others.length > 0) return `${base} +${r.location.others.length} more`;
  return base;
}

function entrySummary(r: JobRecord): string {
  return r.summary?.text ?? textPreview(r.description_html, 300);
}

function byPostedDesc(a: JobRecord, b: JobRecord): number {
  return b.posted_at.localeCompare(a.posted_at) || b.first_seen_at.localeCompare(a.first_seen_at);
}

/** Build an Atom 1.0 document for the newest `FEED_MAX_ITEMS` records. */
export function buildFeed(input: FeedInput): string {
  const site = input.siteUrl.replace(/\/+$/, '');
  const self = `${site}${input.selfPath}`;
  const items = [...input.items].sort(byPostedDesc).slice(0, FEED_MAX_ITEMS);
  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title>${xmlSafe(input.title)}</title>`,
    `  <id>${xmlSafe(self)}</id>`,
    `  <link rel="self" type="application/atom+xml" href="${xmlSafe(self)}"/>`,
    `  <link rel="alternate" type="text/html" href="${xmlSafe(site)}/"/>`,
    `  <updated>${xmlSafe(input.updated)}</updated>`,
    '  <generator>WalkPath</generator>',
  ];
  for (const r of items) {
    const link = `${site}/job/${r.id}`;
    const content = [
      `${r.company.name} · ${locationLabel(r)}`,
      r.season ? `Season: ${r.season}` : null,
      entrySummary(r),
      SAFETY_LINE,
    ]
      .filter((p): p is string => !!p)
      .join('\n\n');
    lines.push(
      '  <entry>',
      `    <id>urn:walkpath:job:${xmlSafe(r.id)}</id>`,
      `    <title>${xmlSafe(`${r.title} @ ${r.company.name}`)}</title>`,
      `    <link rel="alternate" type="text/html" href="${xmlSafe(link)}"/>`,
      `    <updated>${xmlSafe(r.posted_at)}</updated>`,
      `    <published>${xmlSafe(r.posted_at)}</published>`,
      `    <author><name>${xmlSafe(r.company.name)}</name></author>`,
      `    <category term="${xmlSafe(r.role_family)}" label="${xmlSafe(FAMILY_LABELS[r.role_family])}"/>`,
      `    <summary type="text">${xmlSafe(entrySummary(r))}</summary>`,
      `    <content type="text">${xmlSafe(content)}</content>`,
      '  </entry>',
    );
  }
  lines.push('</feed>', '');
  return lines.join('\n');
}

export interface FeedTarget {
  /** Path relative to the data root, e.g. `feeds/all.xml`. */
  file: string;
  title: string;
  matches: (r: JobRecord) => boolean;
}

/** The feeds the publish job writes: all, one per role family, one per state with open jobs, remote. */
export function feedTargets(records: readonly JobRecord[]): FeedTarget[] {
  const targets: FeedTarget[] = [
    { file: 'feeds/all.xml', title: 'WalkPath: all new US tech internships', matches: () => true },
  ];
  for (const family of Object.keys(FAMILY_LABELS) as RoleFamily[]) {
    targets.push({
      file: `feeds/${family}.xml`,
      title: `WalkPath: ${FAMILY_LABELS[family]} internships`,
      matches: (r) => r.role_family === family,
    });
  }
  const states = new Set<string>();
  for (const r of records) {
    if (r.closed_at === null && r.location.state && /^[A-Z]{2}$/.test(r.location.state)) states.add(r.location.state);
  }
  for (const state of [...states].sort()) {
    targets.push({
      file: `feeds/state-${state}.xml`,
      title: `WalkPath: tech internships in ${state}`,
      matches: (r) => r.location.state === state,
    });
  }
  targets.push({
    file: 'feeds/remote.xml',
    title: 'WalkPath: remote US tech internships',
    matches: (r) => r.location.arrangement === 'remote',
  });
  return targets;
}
