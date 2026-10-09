/**
 * One-request board validation against each ATS's public endpoint. Used by the maintainer seed script
 * and by the CI registry check (plan section 11.4). Reads only the first 64 KB of a response so
 * validating thousands of boards does not download gigabytes of job descriptions.
 *
 * Not the crawl client: this is a deliberately small, dependency-free probe with its own polite
 * per-host limiter so the scripts can run before the adapters exist.
 */

export type ProbeAts = 'greenhouse' | 'lever' | 'ashby' | 'workable' | 'smartrecruiters' | 'workday';
export const PROBE_ATS: readonly ProbeAts[] = ['greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters', 'workday'];

export const PROBE_USER_AGENT = 'WalkPathBot/1.0 (+https://github.com/alterj07/walkpath)';
const PEEK_BYTES = 64 * 1024;
const TIMEOUT_MS = 15_000;

export interface ProbeTarget {
  ats: ProbeAts;
  boardKey: string;
  /** Workday data-center number; required for workday. */
  wd?: number | undefined;
}

export type ProbeVerdict = 'active' | 'drop' | 'needs_refingerprint';

export interface ProbeResult {
  verdict: ProbeVerdict;
  /** HTTP status, or 0 on a network error / timeout. */
  status: number;
  note: string;
  /** Company website host found in the response (Greenhouse `absolute_url` on a company domain). */
  domain?: string;
  /** Company display name found in the response (Workable `name`). */
  name?: string;
  /** Set when the board answered under a different key than asked (a Lever site found on api.eu.lever.co). */
  resolvedBoardKey?: string;
}

export interface ProbeRequest {
  url: string;
  init: RequestInit;
}

/** Build the single request that tells us whether a board exists. */
export function probeRequest(target: ProbeTarget): ProbeRequest {
  const headers: Record<string, string> = { 'user-agent': PROBE_USER_AGENT, accept: 'application/json' };
  const key = encodeURIComponent(target.boardKey);
  switch (target.ats) {
    case 'greenhouse':
      return { url: `https://boards-api.greenhouse.io/v1/boards/${key}/jobs`, init: { headers } };
    case 'lever': {
      // EU boards are keyed `eu:{site}` and served from api.eu.lever.co.
      const eu = target.boardKey.startsWith('eu:');
      const site = encodeURIComponent(eu ? target.boardKey.slice(3) : target.boardKey);
      return { url: `https://api${eu ? '.eu' : ''}.lever.co/v0/postings/${site}?mode=json&limit=1`, init: { headers } };
    }
    case 'ashby':
      return { url: `https://api.ashbyhq.com/posting-api/job-board/${key}`, init: { headers } };
    case 'workable':
      // www.workable.com/api/accounts/{sub} (the documented URL) now 302s here; probing the target
      // directly gives a clean 200 / 404 instead of a redirect for every account.
      return { url: `https://apply.workable.com/api/v1/widget/accounts/${key}?details=false`, init: { headers } };
    case 'smartrecruiters':
      return { url: `https://api.smartrecruiters.com/v1/companies/${key}/postings?limit=1`, init: { headers } };
    case 'workday': {
      const [tenant, site] = target.boardKey.split('/');
      if (!tenant || !site) throw new Error(`workday board key must be tenant/site, got "${target.boardKey}"`);
      if (!target.wd) throw new Error(`workday board ${target.boardKey} needs a wd number`);
      return {
        url: `https://${tenant}.wd${target.wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`,
        init: {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: '' }),
        },
      };
    }
  }
}

const MARKERS: Record<ProbeAts, RegExp> = {
  greenhouse: /"jobs"\s*:/,
  lever: /^\s*\[/,
  ashby: /"jobs"\s*:/,
  workable: /"name"\s*:|"jobs"\s*:/,
  smartrecruiters: /"content"\s*:|"totalFound"\s*:/,
  workday: /"jobPostings"\s*:|"total"\s*:/,
};

const ATS_HOSTS = /(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|myworkdayjobs\.com)$/i;
/** Bare hostname: labels of letters, digits and hyphens, a dotted TLD, nothing else. */
export const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Classify a response status + body prefix into a verdict. Exported for tests. */
export function classifyProbe(target: ProbeTarget, status: number, prefix: string): ProbeResult {
  const trimmed = prefix.trimStart();
  if (status === 200) {
    const json = trimmed.startsWith('{') || trimmed.startsWith('[');
    if (json && MARKERS[target.ats].test(trimmed)) {
      const result: ProbeResult = { verdict: 'active', status, note: 'ok' };
      if (target.ats === 'greenhouse') {
        const m = /"absolute_url"\s*:\s*"https?:\/\/([^/"?#]+)/.exec(trimmed);
        const host = m?.[1]?.toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
        if (host && HOSTNAME.test(host) && !ATS_HOSTS.test(host)) result.domain = host;
      }
      if (target.ats === 'workable') {
        const m = /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(trimmed);
        if (m?.[1]) result.name = JSON.parse(`"${m[1]}"`) as string;
      }
      if (target.ats === 'smartrecruiters' && /"totalFound"\s*:\s*0\b/.test(trimmed)) result.note = 'no postings';
      return result;
    }
    return { verdict: 'needs_refingerprint', status, note: json ? 'json without expected shape' : 'non-json 200 body' };
  }
  if (status === 404 || status === 410) return { verdict: 'drop', status, note: 'not found' };
  if (status === 0) return { verdict: 'needs_refingerprint', status, note: 'network error or timeout' };
  return { verdict: 'needs_refingerprint', status, note: `http ${status}` };
}

/** Read at most `limit` bytes of a body, then cancel the stream. */
async function peekBody(res: Response, limit: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(Math.min(total, limit));
  let offset = 0;
  for (const c of chunks) {
    const slice = c.subarray(0, Math.max(0, Math.min(c.byteLength, joined.byteLength - offset)));
    joined.set(slice, offset);
    offset += slice.byteLength;
    if (offset >= joined.byteLength) break;
  }
  return new TextDecoder().decode(joined);
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Probe one board. Never throws; network failures become `needs_refingerprint` with status 0.
 * A Lever site that 404s on api.lever.co is tried once on api.eu.lever.co; a hit comes back as
 * `active` with `resolvedBoardKey: "eu:{site}"`.
 */
export async function probeBoard(target: ProbeTarget, fetchImpl: FetchLike = fetch): Promise<ProbeResult> {
  const result = await probeOnce(target, fetchImpl);
  if (target.ats === 'lever' && result.verdict === 'drop' && !target.boardKey.startsWith('eu:')) {
    const euKey = `eu:${target.boardKey}`;
    const eu = await probeOnce({ ats: 'lever', boardKey: euKey }, fetchImpl);
    if (eu.verdict === 'active') return { ...eu, resolvedBoardKey: euKey, note: 'found on api.eu.lever.co' };
  }
  if (target.ats === 'smartrecruiters' && result.verdict === 'active' && result.note === 'no postings') {
    // The postings API answers 200 with totalFound 0 for companies that do not exist, so an empty
    // board is confirmed through the careers page: 200 or a redirect to the company's own site
    // means the company exists; a redirect to the generic jobs.smartrecruiters.com root means not.
    return smartRecruitersExists(target.boardKey, fetchImpl);
  }
  return result;
}

const SR_GENERIC = /^https?:\/\/(jobs|www)\.smartrecruiters\.com\/?$/i;

async function smartRecruitersExists(company: string, fetchImpl: FetchLike): Promise<ProbeResult> {
  const url = `https://careers.smartrecruiters.com/${encodeURIComponent(company)}`;
  try {
    const res = await fetchImpl(url, { headers: { 'user-agent': PROBE_USER_AGENT, accept: 'text/html' }, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 200) return { verdict: 'active', status: 200, note: 'no postings; careers page exists' };
    const location = res.headers.get('location') ?? '';
    if (res.status >= 300 && res.status < 400 && location) {
      if (SR_GENERIC.test(location)) return { verdict: 'drop', status: res.status, note: 'unknown company (redirects to generic root)' };
      const host = new URL(location, url).hostname.toLowerCase().replace(/^www\./, '');
      const result: ProbeResult = { verdict: 'active', status: res.status, note: 'no postings; careers page redirects to company site' };
      if (HOSTNAME.test(host) && !/smartrecruiters\.com$/.test(host)) result.domain = host;
      return result;
    }
    if (res.status === 404) return { verdict: 'drop', status: 404, note: 'not found' };
    return { verdict: 'needs_refingerprint', status: res.status, note: `careers page http ${res.status}` };
  } catch (e) {
    return { verdict: 'needs_refingerprint', status: 0, note: (e as Error).name === 'TimeoutError' ? 'timeout' : `network error: ${(e as Error).message}` };
  }
}

function retryAfterMs(res: Response): number {
  const header = res.headers.get('retry-after');
  if (!header) return 5000;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.min(Math.max(secs, 1), 60) * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 1000), 60_000) : 5000;
}

async function probeOnce(target: ProbeTarget, fetchImpl: FetchLike): Promise<ProbeResult> {
  let req: ProbeRequest;
  try {
    req = probeRequest(target);
  } catch (e) {
    return { verdict: 'needs_refingerprint', status: 0, note: (e as Error).message };
  }
  try {
    let res = await fetchImpl(req.url, { ...req.init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 429) {
      // One polite retry after the server's own delay.
      const wait = retryAfterMs(res);
      await res.body?.cancel().catch(() => undefined);
      await sleep(wait);
      res = await fetchImpl(req.url, { ...req.init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    }
    const prefix = res.status === 200 ? await peekBody(res, PEEK_BYTES) : '';
    if (res.status !== 200) await res.body?.cancel().catch(() => undefined);
    return classifyProbe(target, res.status, prefix);
  } catch (e) {
    const name = (e as Error).name;
    return { verdict: 'needs_refingerprint', status: 0, note: name === 'TimeoutError' ? 'timeout' : `network error: ${(e as Error).message}` };
  }
}

// ---- polite limiter --------------------------------------------------------------------------

export interface HostPolicy {
  maxConcurrency: number;
  /** Minimum gap between two request starts on the same host. */
  minGapMs: number;
}

/** Per-host concurrency + spacing, plus a global concurrency cap. Plan section 8.2 numbers, probe edition. */
export class PoliteLimiter {
  private readonly global: Semaphore;
  private readonly hosts = new Map<string, { sem: Semaphore; nextStartAt: number }>();
  private readonly policy: (host: string) => HostPolicy;

  constructor(globalConcurrency: number, policy: (host: string) => HostPolicy) {
    this.global = new Semaphore(globalConcurrency);
    this.policy = policy;
  }

  async run<T>(host: string, fn: () => Promise<T>): Promise<T> {
    let entry = this.hosts.get(host);
    if (!entry) {
      entry = { sem: new Semaphore(this.policy(host).maxConcurrency), nextStartAt: 0 };
      this.hosts.set(host, entry);
    }
    const release = await entry.sem.acquire();
    try {
      const gap = this.policy(host).minGapMs;
      const wait = entry.nextStartAt - Date.now();
      entry.nextStartAt = Math.max(Date.now(), entry.nextStartAt) + gap;
      if (wait > 0) await sleep(wait);
      const releaseGlobal = await this.global.acquire();
      try {
        return await fn();
      } finally {
        releaseGlobal();
      }
    } finally {
      release();
    }
  }
}

export class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];
  constructor(count: number) {
    this.available = count;
  }
  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = () => {
        this.available -= 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.available += 1;
          const next = this.queue.shift();
          if (next) next();
        });
      };
      if (this.available > 0) grant();
      else this.queue.push(grant);
    });
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Host of the request a probe target makes (for the limiter). */
export function probeHost(target: ProbeTarget): string {
  return new URL(probeRequest(target).url).hostname;
}

/** Default probe policy: API hosts get the plan's per-ATS concurrency, Workday tenants 1 request every 2 s. */
export function defaultProbePolicy(host: string): HostPolicy {
  if (host.endsWith('.myworkdayjobs.com')) return { maxConcurrency: 1, minGapMs: 2000 };
  if (host.endsWith('greenhouse.io')) return { maxConcurrency: 20, minGapMs: 0 };
  if (host.endsWith('lever.co')) return { maxConcurrency: 10, minGapMs: 100 };
  if (host.endsWith('ashbyhq.com')) return { maxConcurrency: 10, minGapMs: 0 };
  // apply.workable.com answers 429 at 5 concurrent requests; ~3 req/s sequential is tolerated.
  if (host.endsWith('workable.com')) return { maxConcurrency: 1, minGapMs: 300 };
  if (host.endsWith('smartrecruiters.com')) return { maxConcurrency: 8, minGapMs: 125 };
  return { maxConcurrency: 2, minGapMs: 500 };
}
