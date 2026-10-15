/**
 * ATS fingerprinting: turn a careers or job URL (or a careers page's HTML) into the ATS that hosts it
 * and the board key our adapters poll. Implements the table in the plan, section 4.2.
 *
 * Board keys are lowercased for the ATSs whose public endpoints are case-insensitive (Greenhouse,
 * Lever, Ashby, Workable). SmartRecruiters company ids and Workday tenant/site names keep their case.
 */

/** ATSs we can poll today or detect for later. `deferred` = vendor recognised, adapter not planned for MVP. */
export type FingerprintAts =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'workday'
  | 'workable'
  | 'smartrecruiters'
  | 'recruitee'
  | 'breezy'
  | 'pinpoint'
  | 'teamtailor'
  | 'personio'
  | 'bamboohr'
  | 'jazzhr'
  | 'icims'
  | 'deferred';

export interface Fingerprint {
  ats: FingerprintAts;
  /**
   * The key an adapter polls (Greenhouse token, Lever site, Workday `tenant/site`, ...).
   * `null` when the ATS was recognised but the key is not in the URL (a Greenhouse board embedded on
   * a company domain via `?gh_jid=`); resolve it with `fingerprintHtml` on that page.
   */
  boardKey: string | null;
  meta?: Record<string, string | number>;
}

const DEFERRED_VENDORS: Array<[RegExp, string]> = [
  [/(^|\.)taleo\.net$/i, 'taleo'],
  [/^jobs\.jobvite\.com$/i, 'jobvite'],
  [/(^|\.)successfactors\.(com|eu)$/i, 'successfactors'],
  [/(^|\.)oraclecloud\.com$/i, 'oracle'],
  [/^ats\.rippling\.com$/i, 'rippling'],
  [/(^|\.)eightfold\.ai$/i, 'eightfold'],
  [/(^|\.)phenom(people)?\.com$/i, 'phenom'],
];

const WORKDAY_LOCALE = /^[a-z]{2}(-[A-Za-z]{2,4})?$/; // en-US, fr-CA, zh-Hans
const WORKDAY_API = new Set(['wday', 'api', 'login', 'robots.txt']);

function segments(u: URL): string[] {
  return u.pathname.split('/').filter((s) => s.length > 0);
}

function lower(s: string): string {
  return s.toLowerCase();
}

function parseUrl(input: string): URL | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
}

function hostFingerprint(u: URL): Fingerprint | null {
  const host = u.hostname.toLowerCase();
  const segs = segments(u);
  const first = segs[0];
  const params = u.searchParams;

  // Greenhouse: boards.greenhouse.io/{t}, job-boards(.eu).greenhouse.io/{t}, /embed/job_board?for={t}
  if (/^(boards|job-boards)(\.eu)?\.greenhouse\.io$/.test(host)) {
    const forToken = params.get('for');
    if (first === 'embed') return forToken ? { ats: 'greenhouse', boardKey: lower(forToken) } : null;
    if (first && first !== 'v1') return { ats: 'greenhouse', boardKey: lower(first) };
    return forToken ? { ats: 'greenhouse', boardKey: lower(forToken) } : null;
  }
  if (host === 'boards-api.greenhouse.io' && first === 'v1' && segs[1] === 'boards' && segs[2]) {
    return { ats: 'greenhouse', boardKey: lower(segs[2]) };
  }

  // Lever: jobs.lever.co/{s}, jobs.eu.lever.co/{s}, api(.eu).lever.co/v0/postings/{s}
  // EU boards are keyed `eu:{site}` (served from api.eu.lever.co); plain `{site}` means api.lever.co.
  const leverEu = host.includes('.eu.lever.co');
  if (/^jobs(\.eu)?\.lever\.co$/.test(host)) {
    if (!first) return null;
    return { ats: 'lever', boardKey: leverEu ? `eu:${lower(first)}` : lower(first) };
  }
  if (/^api(\.eu)?\.lever\.co$/.test(host) && first === 'v0' && segs[1] === 'postings' && segs[2]) {
    return { ats: 'lever', boardKey: leverEu ? `eu:${lower(segs[2])}` : lower(segs[2]) };
  }

  // Ashby: jobs.ashbyhq.com/{n}
  if (host === 'jobs.ashbyhq.com' && first) {
    // Skip the API, embed scripts and any asset path (a board name never contains a dot).
    if (first === 'api' || first === 'embed' || first.includes('.')) return null;
    return { ats: 'ashby', boardKey: lower(first) };
  }
  if (host === 'api.ashbyhq.com' && first === 'posting-api' && segs[1] === 'job-board' && segs[2]) {
    return { ats: 'ashby', boardKey: lower(segs[2]) };
  }

  // Workday: {tenant}.wd{N}.myworkdayjobs.com/{locale?}/{site}[/...]
  const wdJobs = /^([a-z0-9-]+)\.wd(\d+)\.myworkdayjobs\.com$/.exec(host);
  if (wdJobs) {
    const tenant = wdJobs[1] as string;
    const wd = Number(wdJobs[2]);
    // The cxs API path carries tenant and site explicitly.
    if (first === 'wday' && segs[1] === 'cxs' && segs[2] && segs[3]) {
      return { ats: 'workday', boardKey: `${segs[2]}/${segs[3]}`, meta: { tenant: segs[2], site: segs[3], wd } };
    }
    const site = segs.find((s) => !WORKDAY_LOCALE.test(s) && !WORKDAY_API.has(s));
    if (!site) return null;
    return { ats: 'workday', boardKey: `${tenant}/${site}`, meta: { tenant, site, wd } };
  }
  // Workday (myworkdaysite): [{tenant}.]wd{N}.myworkdaysite.com/{locale?}/recruiting/{tenant}/{site}
  const wdSite = /^(?:([a-z0-9-]+)\.)?wd(\d+)\.myworkdaysite\.com$/.exec(host);
  if (wdSite) {
    const wd = Number(wdSite[2]);
    const idx = segs.indexOf('recruiting');
    const tenant = idx >= 0 ? segs[idx + 1] : undefined;
    const site = idx >= 0 ? segs[idx + 2] : undefined;
    if (!tenant || !site) return null;
    return { ats: 'workday', boardKey: `${tenant}/${site}`, meta: { tenant, site, wd, host: 'myworkdaysite' } };
  }

  // Workable: apply.workable.com/{sub}, {sub}.workable.com, www.workable.com/api/accounts/{sub}
  if (host === 'apply.workable.com' && first) {
    return first === 'api' ? null : { ats: 'workable', boardKey: lower(first) };
  }
  if (host === 'www.workable.com' && first === 'api' && segs[1] === 'accounts' && segs[2]) {
    return { ats: 'workable', boardKey: lower(segs[2]) };
  }
  const workableSub = /^([a-z0-9-]+)\.workable\.com$/.exec(host);
  if (workableSub && !['www', 'apply', 'jobs', 'help', 'resources'].includes(workableSub[1] as string)) {
    return { ats: 'workable', boardKey: workableSub[1] as string };
  }

  // SmartRecruiters: careers.smartrecruiters.com/{c}, jobs.smartrecruiters.com/{c}, api .../companies/{c}
  if (/^(careers|jobs)\.smartrecruiters\.com$/.test(host) && first) {
    return { ats: 'smartrecruiters', boardKey: first };
  }
  if (host === 'api.smartrecruiters.com' && first === 'v1' && segs[1] === 'companies' && segs[2]) {
    return { ats: 'smartrecruiters', boardKey: segs[2] };
  }

  // Subdomain-keyed ATSs.
  const sub = (re: RegExp): string | null => {
    const m = re.exec(host);
    const s = m?.[1];
    return s && s !== 'www' ? s : null;
  };
  const recruitee = sub(/^([a-z0-9-]+)\.recruitee\.com$/);
  if (recruitee) return { ats: 'recruitee', boardKey: recruitee };
  const breezy = sub(/^([a-z0-9-]+)\.breezy\.hr$/);
  if (breezy) return { ats: 'breezy', boardKey: breezy };
  const pinpoint = sub(/^([a-z0-9-]+)\.pinpointhq\.com$/);
  if (pinpoint) return { ats: 'pinpoint', boardKey: pinpoint };
  const teamtailor = sub(/^([a-z0-9-]+)\.teamtailor\.com$/);
  if (teamtailor && !['career', 'app', 'api'].includes(teamtailor)) return { ats: 'teamtailor', boardKey: teamtailor };
  const personio = sub(/^([a-z0-9-]+)\.jobs\.personio\.(de|com)$/);
  if (personio) return { ats: 'personio', boardKey: personio };
  const bamboo = sub(/^([a-z0-9-]+)\.bamboohr\.com$/);
  if (bamboo && (first === 'careers' || first === 'jobs')) return { ats: 'bamboohr', boardKey: bamboo };
  const jazz = sub(/^([a-z0-9-]+)\.applytojob\.com$/);
  if (jazz) return { ats: 'jazzhr', boardKey: jazz };
  // iCIMS portals: https://{label}.icims.com/jobs/... (label = careers-gdms, university-uber, ...).
  const icims = sub(/^([a-z0-9][a-z0-9-]{0,62})\.icims\.com$/);
  if (icims && !['www', 'cdn01', 'cdn02', 'media', 'images'].includes(icims)) return { ats: 'icims', boardKey: icims };

  // Vendors we recognise but do not poll in the MVP.
  for (const [re, vendor] of DEFERRED_VENDORS) {
    if (re.test(host)) {
      if (vendor === 'jobvite' && first === 'careers' && segs[1]) {
        return { ats: 'deferred', boardKey: segs[1], meta: { vendor } };
      }
      return { ats: 'deferred', boardKey: host, meta: { vendor } };
    }
  }
  // SuccessFactors self-hosted pattern: jobs.{company}.com/search/?q=
  if (/^jobs\./.test(host) && first === 'search' && params.has('q')) {
    return { ats: 'deferred', boardKey: host, meta: { vendor: 'successfactors' } };
  }
  return null;
}

/**
 * Fingerprint a URL. Returns `null` when no known ATS is recognised.
 * A Greenhouse job embedded on a company domain (`?gh_jid=123`) returns `boardKey: null` unless the
 * URL also carries `for=<token>`.
 */
export function fingerprintUrl(input: string): Fingerprint | null {
  const u = parseUrl(input);
  if (!u) return null;
  const byHost = hostFingerprint(u);
  if (byHost) return byHost;
  const ghJid = u.searchParams.get('gh_jid');
  if (ghJid) {
    const forToken = u.searchParams.get('for');
    return forToken
      ? { ats: 'greenhouse', boardKey: lower(forToken), meta: { ghJid } }
      : { ats: 'greenhouse', boardKey: null, meta: { ghJid } };
  }
  return null;
}

const ATTR_URL = /(?:src|href|action|data-src|content)\s*=\s*["']([^"']+)["']/gi;
const GH_FOR = /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([A-Za-z0-9_-]+)/i;
const GRNHSE_LOAD = /Grnhse\.Iframe\.load\s*\(|grnhse_iframe/i;
const GH_BOARD_TOKEN = /["'`](?:boardToken|board_token|gh_board|ghBoard)["'`]?\s*[:=]\s*["'`]([A-Za-z0-9_-]+)["'`]/;
const LEVER_EMBED = /(?:jobs|api)(?:\.eu)?\.lever\.co\/(?:v0\/postings\/)?([a-z0-9-]+)/i;
const ASHBY_EMBED = /jobs\.ashbyhq\.com\/(?:embed\/)?([a-z0-9-]+)|ashby_embed|ashbyhq\.com\/embed/i;
const ASHBY_TOKEN = /["']?(?:jobBoardName|job-board-name|data-ashby-job-board)["']?\s*[:=]\s*["']([a-z0-9-]+)["']/i;

/**
 * Scan a careers page for an embedded ATS board: script/iframe/link URLs first, then embed markers
 * (`grnhse`, `gh_jid`, `lever`, `ashby_embed`). Returns the first resolvable fingerprint, else null.
 */
export function fingerprintHtml(html: string, baseUrl: string): Fingerprint | null {
  const base = parseUrl(baseUrl);
  const ghFor = GH_FOR.exec(html);
  if (ghFor?.[1]) return { ats: 'greenhouse', boardKey: lower(ghFor[1]) };

  let unresolved: Fingerprint | null = null;
  for (const m of html.matchAll(ATTR_URL)) {
    const raw = m[1] as string;
    let abs = raw;
    if (base) {
      try {
        abs = new URL(raw, base).toString();
      } catch {
        continue;
      }
    }
    const fp = fingerprintUrl(abs);
    if (!fp) continue;
    // Prefer a fingerprint with a key; skip self links to the base host's own deferred vendor.
    if (fp.boardKey !== null) {
      if (base && fp.ats === 'deferred' && fp.boardKey === base.hostname.toLowerCase()) continue;
      return fp;
    }
    unresolved ??= fp;
  }

  const ghToken = GH_BOARD_TOKEN.exec(html);
  if (ghToken?.[1] && (GRNHSE_LOAD.test(html) || /greenhouse/i.test(html))) {
    return { ats: 'greenhouse', boardKey: lower(ghToken[1]) };
  }
  const lever = LEVER_EMBED.exec(html);
  if (lever?.[1]) return { ats: 'lever', boardKey: lower(lever[1]) };
  const ashbyToken = ASHBY_TOKEN.exec(html);
  if (ashbyToken?.[1]) return { ats: 'ashby', boardKey: lower(ashbyToken[1]) };
  const ashby = ASHBY_EMBED.exec(html);
  if (ashby?.[1] && ashby[1] !== 'embed') return { ats: 'ashby', boardKey: lower(ashby[1]) };

  if (unresolved) return unresolved;
  if (GRNHSE_LOAD.test(html) || /[?&]gh_jid=/.test(html)) return { ats: 'greenhouse', boardKey: null };
  return null;
}

/** Canonical public board URL for a fingerprint, used as `careers_url` when the registry has nothing better. */
export function boardUrl(fp: Fingerprint): string | null {
  const key = fp.boardKey;
  if (key === null) return null;
  switch (fp.ats) {
    case 'greenhouse':
      return `https://job-boards.greenhouse.io/${key}`;
    case 'lever':
      return key.startsWith('eu:') ? `https://jobs.eu.lever.co/${key.slice(3)}` : `https://jobs.lever.co/${key}`;
    case 'ashby':
      return `https://jobs.ashbyhq.com/${key}`;
    case 'workable':
      return `https://apply.workable.com/${key}`;
    case 'smartrecruiters':
      return `https://jobs.smartrecruiters.com/${key}`;
    case 'workday': {
      const [tenant, site] = key.split('/');
      const wd = fp.meta?.wd ?? 1;
      if (!tenant || !site) return null;
      return fp.meta?.host === 'myworkdaysite'
        ? `https://wd${wd}.myworkdaysite.com/recruiting/${tenant}/${site}`
        : `https://${tenant}.wd${wd}.myworkdayjobs.com/${site}`;
    }
    case 'recruitee':
      return `https://${key}.recruitee.com`;
    case 'breezy':
      return `https://${key}.breezy.hr`;
    case 'pinpoint':
      return `https://${key}.pinpointhq.com`;
    case 'teamtailor':
      return `https://${key}.teamtailor.com`;
    case 'personio':
      return `https://${key}.jobs.personio.de`;
    case 'bamboohr':
      return `https://${key}.bamboohr.com/careers`;
    case 'jazzhr':
      return `https://${key}.applytojob.com`;
    case 'icims':
      return `https://${key}.icims.com/jobs/search?ss=1`;
    case 'deferred':
      return null;
  }
}
