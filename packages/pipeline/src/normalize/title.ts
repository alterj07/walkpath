import { resolveCityAlias, resolveState } from '../data/us-gazetteer.ts';

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
  return { title: title || title_raw.trim(), title_raw };
}
