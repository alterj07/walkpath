/**
 * Apply-URL validation (plan section 11.3). The Apply button is the whole attack
 * surface of a static job board, so every URL from an ATS goes through here.
 */

export const SHORTENER_HOSTS: ReadonlySet<string> = new Set([
  'bit.ly',
  't.co',
  'tinyurl.com',
  'lnkd.in',
  'goo.gl',
  'ow.ly',
  'buff.ly',
  'rb.gy',
  'cutt.ly',
  'is.gd',
  'tiny.cc',
  'shorturl.at',
  't.ly',
  'short.io',
  'rebrand.ly',
  'shorte.st',
  'bl.ink',
]);

/** Query parameters that only track the click and never change the destination. */
const TRACKING_PARAM_EXACT: ReadonlySet<string> = new Set([
  'gh_src',
  'lever-source',
  'fbclid',
  'gclid',
  'msclkid',
]);
/** Stripped only on ATS hosts, where they are known to be attribution, not routing. */
const TRACKING_PARAM_ATS_ONLY: ReadonlySet<string> = new Set(['ref', 'source']);

export type ApplyUrlRejection =
  | 'unparseable'
  | 'scheme'
  | 'ip_literal'
  | 'userinfo'
  | 'shortener'
  | 'empty_host';

export type ApplyUrlResult =
  | { ok: true; url: string; needsUpgrade: boolean }
  | { ok: false; reason: ApplyUrlRejection };

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function isIpLiteral(hostname: string): boolean {
  return IPV4.test(hostname) || hostname.startsWith('[') || hostname.includes(':');
}

function stripTracking(url: URL, onAtsHost: boolean): void {
  for (const key of [...url.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (
      lower.startsWith('utm_') ||
      TRACKING_PARAM_EXACT.has(lower) ||
      (onAtsHost && TRACKING_PARAM_ATS_ONLY.has(lower))
    ) {
      url.searchParams.delete(key);
    }
  }
}

export interface ValidateApplyUrlOptions {
  /** Hosts (exact or `*.example.com`) treated as the ATS's own; enables ATS-only param stripping. */
  atsHosts?: readonly string[];
}

/**
 * Accepts only https URLs (http returns `needsUpgrade: true` with the https form so the
 * caller can probe port 443 before publishing), rejects dangerous schemes, IP-literal
 * hosts, embedded credentials and URL shorteners, and strips tracking parameters.
 */
export function validateApplyUrl(raw: string, opts: ValidateApplyUrlOptions = {}): ApplyUrlResult {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'unparseable' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'scheme' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'userinfo' };
  const host = url.hostname.toLowerCase();
  if (host === '') return { ok: false, reason: 'empty_host' };
  if (isIpLiteral(host)) return { ok: false, reason: 'ip_literal' };
  if (SHORTENER_HOSTS.has(host) || SHORTENER_HOSTS.has(host.replace(/^www\./, ''))) {
    return { ok: false, reason: 'shortener' };
  }
  const needsUpgrade = url.protocol === 'http:';
  if (needsUpgrade) url.protocol = 'https:';
  url.hash = '';
  stripTracking(url, hostMatches(host, opts.atsHosts ?? []));
  return { ok: true, url: url.toString(), needsUpgrade };
}

/** `pattern` is an exact host or `*.suffix` (which matches any subdomain, not the bare suffix). */
export function hostMatchesPattern(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase();
  const pat = pattern.toLowerCase();
  if (pat.startsWith('*.')) {
    const suffix = pat.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === pat;
}

export function hostMatches(hostname: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => hostMatchesPattern(hostname, p));
}

export interface AllowedHostOptions {
  /** Legitimate hosts for the ATS (exact or `*.wildcard`). */
  atsHosts: readonly string[];
  /** The company's own registered domain; it and every subdomain are accepted. */
  companyDomain?: string | null | undefined;
}

/**
 * True when the URL's host is one the adapter knows for its ATS, or the company's
 * registered domain (or a subdomain of it). Anything else gets the "apply on the
 * company's careers page" downgrade.
 */
export function isAllowedApplyHost(rawUrl: string, opts: AllowedHostOptions): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostMatches(host, opts.atsHosts)) return true;
  const domain = opts.companyDomain?.trim().toLowerCase();
  if (!domain) return false;
  return host === domain || host.endsWith(`.${domain}`);
}
