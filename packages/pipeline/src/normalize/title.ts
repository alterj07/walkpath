import { citiesByName, normalizePlaceKey, resolveCityAlias, resolveState } from '../data/us-gazetteer.ts';

export interface NormalizedTitle {
  title: string;
  title_raw: string;
}

// "(REQ-12345)", "[R123456]", "#12345", "- 2026-1234", "(Job ID: 12345)", "- JR0012345"
const REQ_ID_RES: readonly RegExp[] = [
  /\s*[([{]\s*(?:req(?:uisition)?|job\s*id|job\s*#|id|jr|r)?\s*[-:#]?\s*[A-Z]{0,3}-?\d{3,}[A-Z0-9-]*\s*[)\]}]/gi,
  /\s*[-–—|#:]\s*(?:req(?:uisition)?\s*(?:id|#|no\.?)?\s*[:#-]?\s*)?[A-Z]{0,3}\d{4,}(?:-\d+)?(?=\s|$)/gi,
  /\s*[-–—|]\s*(?:req(?:uisition)?|job\s*id|jr)\s*[:#-]?\s*[A-Z0-9-]+(?=\s|$)/gi,
  /\s*#\s*\d{3,}\b/g,
];

// "(Intern)", "(Internship)", "(Co-op)" at the very end: lifted off so a location before it can be
// stripped, then put back as a plain word so the internship gate still sees it.
const TRAILING_INTERN_PAREN_RE = /\s*\((intern(?:ship)?|co-?op)\)\s*$/i;
const INTERN_WORD_RE = /\b(intern|interns|internship|internships|co-?op|co-?ops)\b/i;
// City names that are also everyday words in job titles; never treated as a location suffix.
const CITY_WORD_DENYLIST = new Set([
  'mobile', 'enterprise', 'commerce', 'industry', 'independence', 'orange', 'reading', 'surprise',
  'union', 'liberty', 'temple', 'mesa', 'normal', 'paradise', 'security', 'vista', 'hope', 'buffalo',
  'auburn', 'garland', 'chandler', 'gilbert', 'frisco', 'cary', 'plano', 'victoria', 'anchorage',
]);
const MIN_POP_FOR_BARE_CITY_SUFFIX = 100_000;

function isBareCityName(s: string): boolean {
  const key = normalizePlaceKey(s);
  if (CITY_WORD_DENYLIST.has(key)) return false;
  const matches = citiesByName().get(key) ?? [];
  const top = matches[0];
  const runnerUp = matches[1];
  if (top === undefined) return false;
  if (matches.length === 1) return true;
  // Same dominance rule as parseLocation: big and at least 3× the next city of that name.
  return top.population >= MIN_POP_FOR_BARE_CITY_SUFFIX && (runnerUp === undefined || top.population >= 3 * runnerUp.population);
}

const PAREN_LOCATION_RE = /\s*\((?:remote|hybrid|on-?site|in[- ]person|us|usa|united states|multiple locations)(?:[^)]*)\)\s*$/i;

function looksLikeLocation(segment: string): boolean {
  const s = segment.trim();
  if (!s) return false;
  if (/^(remote|hybrid|on-?site|in[- ]person|multiple locations|various locations|us|usa|united states)$/i.test(s)) return true;
  // "Richmond, VA", "New York, New York", "Austin, Texas, US"
  const parts = s.split(/\s*,\s*/);
  if (parts.length >= 2 && parts.slice(1).some((p) => resolveState(p) || /^(us|usa|united states)$/i.test(p))) {
    return true;
  }
  if (parts.length === 1 && resolveCityAlias(s)) return true;
  if (parts.length === 1 && isBareCityName(s)) return true;
  if (parts.length === 1 && resolveState(s) && !/^(la|in|or|ok|hi|me|oh|de|co|pa|md|mo|ma)$/i.test(s)) return true;
  return false;
}

/**
 * Trim, collapse whitespace, strip requisition ids and trailing location suffixes.
 * The raw title is kept alongside for display and for the content hash.
 */
export function normalizeTitle(raw: string): NormalizedTitle {
  const title_raw = raw;
  let title = raw.replace(/\s+/g, ' ').trim();
  for (const re of REQ_ID_RES) title = title.replace(re, '');
  const internParen = title.match(TRAILING_INTERN_PAREN_RE);
  if (internParen) title = title.slice(0, internParen.index);
  title = title.replace(PAREN_LOCATION_RE, '');

  // Trailing "- Richmond, VA", "| New York", "– Remote", possibly repeated.
  let changed = true;
  while (changed) {
    changed = false;
    const m = title.match(/^(.*?)\s+[-–—|]\s+([^-–—|]+)$/);
    if (m && m[1] && m[2] && looksLikeLocation(m[2])) {
      title = m[1];
      changed = true;
    }
  }
  title = title.replace(/\s*\(\s*\)\s*/g, ' ').replace(/\s+/g, ' ').replace(/[\s\-–—|,:]+$/g, '').trim();
  if (internParen && internParen[1] && !INTERN_WORD_RE.test(title)) {
    title = `${title} ${internParen[1]}`;
  }
  return { title: title || title_raw.trim(), title_raw };
}
