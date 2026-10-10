import { HostLimiter, type HostLimits } from './limiter.ts';
import { isPathAllowed, parseRobots, type RobotsRules } from './robots.ts';
import { hostMatches } from '../links.ts';

export const BOT_USER_AGENT = 'WalkPathBot/1.0 (+https://github.com/alterj07/walkpath)';
export const BOT_TOKEN = 'WalkPathBot';

export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECTS = 3;
export const MAX_ATTEMPTS = 4;
/** Longest backoff we will wait inside a run; a larger Retry-After skips the board for this run. */
export const MAX_BACKOFF_MS = 60_000;
/**
 * Host circuit breaker (plan 10.3: "back off a host after any 429/403/5xx", "a block is a signal
 * to stop"). A 403 or an exhausted retry budget counts as one block: the host is cooled down on an
 * escalating schedule, and after BREAKER_TRIP_AFTER consecutive blocks the circuit opens for the
 * rest of the run, so nothing more is sent to a host that is refusing us. Measured 2026-10-10:
 * boards-api.greenhouse.io answered 403 to ~11,900 requests after blocking us 70 s into a crawl.
 */
export const BREAKER_COOLDOWNS_MS = [2 * 60_000, 10 * 60_000, 30 * 60_000] as const;
export const BREAKER_TRIP_AFTER = 3;
const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
const ROBOTS_MAX_BYTES = 512 * 1024;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  userAgent?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
  /** Client-wide default; set false in tests that do not want a robots.txt round trip. */
  respectRobots?: boolean;
}

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** Hosts this request may target and follow redirects within (exact or `*.wildcard`). */
  allowedHosts: readonly string[];
  limits: HostLimits;
  /** Validators from the previous successful response, for conditional GET. */
  etag?: string | null;
  lastModified?: string | null;
  /** Per-request body cap for sources whose single response is legitimately large (e.g. the SimplifyJobs lists). */
  maxBodyBytes?: number;
  /**
   * Per-request robots.txt override, default true. The ONE legitimate exception is the
   * SmartRecruiters adapter: api.smartrecruiters.com/robots.txt disallows everything for
   * `*`, and plan section 10.2 has us call it as a registered API client with a key, not
   * as a crawler. Every other adapter leaves this unset.
   */
  respectRobots?: boolean;
}

/** Per-host breaker state, for the crawl summary log (hosts and counts only). */
export interface HostHealth {
  blocked_until: number;
  consecutive_blocks: number;
  circuit_open: boolean;
  /** Requests refused locally while the circuit was open. */
  rejected: number;
}

export interface HttpResponse {
  status: number;
  /** True on 304; `body` is then empty. */
  notModified: boolean;
  body: string;
  etag: string | null;
  lastModified: string | null;
  url: string;
}

export type HttpErrorCode =
  | 'host_not_allowed'
  | 'robots_disallowed'
  | 'redirect_not_allowed'
  | 'too_many_redirects'
  | 'body_too_large'
  | 'bad_json'
  | 'timeout'
  | 'network'
  | 'http_status'
  /** 403: the host refused us (bot management or policy). Not retried; /status reports it as a block. */
  | 'forbidden'
  | 'retry_exhausted'
  /** The host blocked us repeatedly this run; the request was never sent (see BREAKER_TRIP_AFTER). */
  | 'circuit_open';

export class HttpError extends Error {
  readonly code: HttpErrorCode;
  readonly status: number | null;
  readonly host: string;
  constructor(code: HttpErrorCode, host: string, status: number | null = null, message?: string) {
    // Message carries codes, hosts and statuses only; never bodies or headers (logs are public).
    super(message ?? `${code} (${host}${status === null ? '' : ` ${status}`})`);
    this.name = 'HttpError';
    this.code = code;
    this.status = status;
    this.host = host;
  }
}

function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

/** Seconds or HTTP-date; null when absent or unparseable. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/** Rejects with an AbortError when `signal` fires; resolves never. */
function abortedPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    };
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * Read the body incrementally under `cap` bytes. The caller's AbortController is still
 * armed while we read, so a stall mid-body surfaces as a timeout, not a raw AbortError.
 */
async function readCapped(res: Response, cap: number, host: string, signal: AbortSignal): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) throw new HttpError('body_too_large', host, res.status);
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // One listener for the whole body, not one per chunk.
  const aborted = abortedPromise(signal);
  aborted.catch(() => undefined);
  try {
    while (true) {
      if (signal.aborted) throw new HttpError('timeout', host, res.status);
      let step: Awaited<ReturnType<typeof reader.read>>;
      try {
        // Race the read against the deadline: not every body stream propagates the abort.
        step = await Promise.race([reader.read(), aborted]);
      } catch (err) {
        if (signal.aborted || isAbort(err)) throw new HttpError('timeout', host, res.status);
        throw new HttpError('network', host, res.status);
      }
      if (step.done) break;
      total += step.value.byteLength;
      if (total > cap) throw new HttpError('body_too_large', host, res.status);
      chunks.push(step.value);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(joined);
}

async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

/**
 * The one HTTP client every adapter uses. Fixed User-Agent, timeout covering headers and
 * body, body cap, host-pinned redirects, per-host rate limiting, backoff on 429/5xx,
 * robots.txt, and conditional GET. Dependency-free so it can be tested with a fake fetch.
 */
export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly respectRobots: boolean;
  private readonly limiter: HostLimiter;
  private readonly robotsCache = new Map<string, { rules: RobotsRules; fetchedAt: number }>();
  private readonly robotsPending = new Map<string, Promise<RobotsRules>>();
  private readonly health = new Map<string, HostHealth>();

  constructor(opts: HttpClientOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.userAgent = opts.userAgent ?? BOT_USER_AGENT;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBodyBytes = opts.maxBodyBytes ?? MAX_BODY_BYTES;
    this.respectRobots = opts.respectRobots ?? true;
    this.limiter = new HostLimiter(this.now, this.sleep);
  }

  /** GET and parse JSON. Returns `unknown`: adapters must validate with a schema. */
  async getJson(req: Omit<HttpRequest, 'method' | 'body'>): Promise<{ data: unknown } & HttpResponse> {
    const res = await this.request({ ...req, method: 'GET', headers: { accept: 'application/json', ...req.headers } });
    if (res.notModified) return { ...res, data: null };
    try {
      return { ...res, data: JSON.parse(res.body) as unknown };
    } catch {
      // SyntaxError messages embed body snippets; never let them reach a (public) log.
      throw new HttpError('bad_json', hostOf(res.url), res.status);
    }
  }

  /** Breaker state per host seen this run. */
  hostHealth(): Record<string, HostHealth> {
    return Object.fromEntries([...this.health].map(([h, v]) => [h, { ...v }]));
  }

  private healthOf(host: string): HostHealth {
    let h = this.health.get(host);
    if (!h) {
      h = { blocked_until: 0, consecutive_blocks: 0, circuit_open: false, rejected: 0 };
      this.health.set(host, h);
    }
    return h;
  }

  /** A 403 or an exhausted retry budget: cool the host down, trip the circuit after repeats. */
  private noteBlock(host: string): void {
    const h = this.healthOf(host);
    h.consecutive_blocks += 1;
    const cooldown = BREAKER_COOLDOWNS_MS[Math.min(h.consecutive_blocks, BREAKER_COOLDOWNS_MS.length) - 1]!;
    this.limiter.block(host, cooldown);
    h.blocked_until = this.now() + cooldown;
    if (h.consecutive_blocks >= BREAKER_TRIP_AFTER) h.circuit_open = true;
  }

  private noteSuccess(host: string): void {
    const h = this.healthOf(host);
    h.consecutive_blocks = 0;
    h.blocked_until = 0;
  }

  private assertCircuitClosed(host: string): void {
    const h = this.health.get(host);
    if (h?.circuit_open) {
      h.rejected += 1;
      throw new HttpError('circuit_open', host, 403);
    }
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const host = hostOf(req.url);
    if (!hostMatches(host, req.allowedHosts)) throw new HttpError('host_not_allowed', host);
    let url = req.url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      this.assertCircuitClosed(hostOf(url));
      const result = await this.requestWithRetry(url, req);
      if (result.kind === 'redirect') {
        url = result.url;
        continue;
      }
      return result.response;
    }
    throw new HttpError('too_many_redirects', hostOf(url));
  }

  private async requestWithRetry(
    url: string,
    req: HttpRequest,
  ): Promise<{ kind: 'redirect'; url: string } | { kind: 'done'; response: HttpResponse }> {
    const host = hostOf(url);
    const wantRobots = req.respectRobots ?? this.respectRobots;
    const limits = wantRobots ? await this.limitsAfterRobots(url, req) : req.limits;
    try {
      const out = await this.attempts(url, req, host, limits);
      this.noteSuccess(host);
      return out;
    } catch (err) {
      if (err instanceof HttpError && (err.code === 'forbidden' || err.code === 'retry_exhausted')) this.noteBlock(host);
      throw err;
    }
  }

  private async attempts(
    url: string,
    req: HttpRequest,
    host: string,
    limits: HostLimits,
  ): Promise<{ kind: 'redirect'; url: string } | { kind: 'done'; response: HttpResponse }> {
    let lastStatus: number | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      // The circuit can open while we were waiting for a slot (a sibling request got blocked).
      this.assertCircuitClosed(host);
      const release = await this.limiter.acquire(host, limits);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchOnce(url, req, controller.signal);
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable) {
          lastStatus = res.status;
          await discard(res);
          if (attempt === MAX_ATTEMPTS) break;
          const retryAfter = parseRetryAfter(res.headers.get('retry-after'), this.now());
          if (retryAfter !== null && retryAfter > MAX_BACKOFF_MS) {
            // Too long to wait inside this run: block the host for the full period and skip.
            this.limiter.block(host, retryAfter);
            throw new HttpError('retry_exhausted', host, res.status);
          }
          this.backoff(host, attempt, retryAfter);
          continue;
        }
        return await this.consume(res, url, req, controller.signal);
      } catch (err) {
        if (err instanceof HttpError && err.code === 'timeout' && attempt < MAX_ATTEMPTS) {
          this.backoff(host, attempt, null);
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
        release();
      }
    }
    throw new HttpError('retry_exhausted', host, lastStatus);
  }

  /** Turn a non-retryable response into a redirect instruction or a finished HttpResponse. */
  private async consume(
    res: Response,
    url: string,
    req: HttpRequest,
    signal: AbortSignal,
  ): Promise<{ kind: 'redirect'; url: string } | { kind: 'done'; response: HttpResponse }> {
    const h = hostOf(url);
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const location = res.headers.get('location');
      await discard(res);
      if (!location) throw new HttpError('http_status', h, res.status);
      const next = new URL(location, url);
      if (next.protocol !== 'https:' && next.protocol !== 'http:') throw new HttpError('redirect_not_allowed', h, res.status);
      const nextHost = next.hostname.toLowerCase();
      if (!hostMatches(nextHost, req.allowedHosts)) throw new HttpError('redirect_not_allowed', nextHost, res.status);
      return { kind: 'redirect', url: next.toString() };
    }
    if (res.status === 304) {
      await discard(res);
      return {
        kind: 'done',
        response: {
          status: 304,
          notModified: true,
          body: '',
          etag: res.headers.get('etag') ?? req.etag ?? null,
          lastModified: res.headers.get('last-modified') ?? req.lastModified ?? null,
          url,
        },
      };
    }
    if (res.status < 200 || res.status >= 300) {
      await discard(res);
      throw new HttpError(res.status === 403 ? 'forbidden' : 'http_status', h, res.status);
    }
    const body = await readCapped(res, req.maxBodyBytes ?? this.maxBodyBytes, h, signal);
    return {
      kind: 'done',
      response: {
        status: res.status,
        notModified: false,
        body,
        etag: res.headers.get('etag'),
        lastModified: res.headers.get('last-modified'),
        url,
      },
    };
  }

  /** Exponential (1 s, 2 s, 4 s ...) with ±30 % jitter, or Retry-After when the server sends one. */
  private backoff(host: string, attempt: number, retryAfterMs: number | null): void {
    const base = 1000 * 2 ** (attempt - 1);
    const jitter = 1 + (this.random() * 2 - 1) * 0.3;
    const delay = retryAfterMs !== null ? Math.max(retryAfterMs, base) : Math.round(base * jitter);
    this.limiter.block(host, Math.min(delay, MAX_BACKOFF_MS));
  }

  private async fetchOnce(url: string, req: HttpRequest, signal: AbortSignal): Promise<Response> {
    const host = hostOf(url);
    const headers: Record<string, string> = { 'user-agent': this.userAgent, ...(req.headers ?? {}) };
    if (req.etag) headers['if-none-match'] = req.etag;
    if (req.lastModified) headers['if-modified-since'] = req.lastModified;
    const init: RequestInit = { method: req.method ?? 'GET', headers, redirect: 'manual', signal };
    if (req.body !== undefined) init.body = req.body;
    try {
      return await this.fetchImpl(url, init);
    } catch (err) {
      if (signal.aborted || isAbort(err)) throw new HttpError('timeout', host);
      throw new HttpError('network', host, null, `network (${host}): ${err instanceof Error ? err.name : 'error'}`);
    }
  }

  /** Check robots for `url`; returns the effective limits (Crawl-delay may raise minDelayMs). Never mutates `req`. */
  private async limitsAfterRobots(url: string, req: HttpRequest): Promise<HostLimits> {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const rules = await this.robotsFor(u.origin, host, req);
    if (!isPathAllowed(rules, `${u.pathname}${u.search}`)) throw new HttpError('robots_disallowed', host);
    if (rules.crawlDelayMs !== null && rules.crawlDelayMs > req.limits.minDelayMs) {
      return { ...req.limits, minDelayMs: rules.crawlDelayMs };
    }
    return req.limits;
  }

  private robotsFor(origin: string, host: string, req: HttpRequest): Promise<RobotsRules> {
    const cached = this.robotsCache.get(host);
    if (cached && this.now() - cached.fetchedAt < ROBOTS_TTL_MS) return Promise.resolve(cached.rules);
    // Concurrent first requests to a host share one robots.txt fetch.
    let pending = this.robotsPending.get(host);
    if (!pending) {
      pending = this.fetchRobots(origin, host, req).finally(() => this.robotsPending.delete(host));
      this.robotsPending.set(host, pending);
    }
    return pending;
  }

  /**
   * Fetch robots.txt, following same-host-family redirects (http→https, apex↔www) up to
   * MAX_REDIRECTS. A 404, a 5xx, a redirect elsewhere or a network error all mean "no
   * rules for this run" (the conventional interpretation); the result is cached for 24 h
   * either way so a flaky robots.txt does not cost a round trip per request.
   */
  private async fetchRobots(origin: string, host: string, req: HttpRequest): Promise<RobotsRules> {
    let rules: RobotsRules = { allow: [], disallow: [], crawlDelayMs: null };
    const release = await this.limiter.acquire(host, req.limits);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let url = `${origin}/robots.txt`;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const robotsReq: HttpRequest = { url, method: 'GET', allowedHosts: req.allowedHosts, limits: req.limits };
        const res = await this.fetchOnce(url, robotsReq, controller.signal);
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get('location');
          await discard(res);
          if (!location) break;
          const next = new URL(location, url);
          const nextHost = next.hostname.toLowerCase();
          const sameFamily = nextHost === host || nextHost === `www.${host}` || host === `www.${nextHost}`;
          if (!sameFamily || (next.protocol !== 'https:' && next.protocol !== 'http:')) break;
          url = next.toString();
          continue;
        }
        if (res.status >= 200 && res.status < 300) {
          rules = parseRobots(await readCapped(res, ROBOTS_MAX_BYTES, host, controller.signal), BOT_TOKEN);
        } else {
          await discard(res);
        }
        break;
      }
    } catch {
      // Unreachable robots.txt means "no rules".
    } finally {
      clearTimeout(timer);
      release();
    }
    this.robotsCache.set(host, { rules, fetchedAt: this.now() });
    return rules;
  }
}
