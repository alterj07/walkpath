import type { Board } from '../schema/board.ts';
import type { Ats, JobPostingInput } from '../schema/index.ts';
import type { HttpClient } from '../http/client.ts';
import type { HostLimits } from '../http/limiter.ts';

/** Crawl etiquette for one ATS (plan sections 4.4 and 10.3). The User-Agent is pinned by HttpClient. */
export interface AdapterPolicy {
  /** Minimum gap between two requests to the same host. */
  minDelayMs: number;
  maxConcurrencyPerHost: number;
  /**
   * Hosts the adapter may talk to and follow redirects within, and the hosts an
   * apply URL may legitimately point at. Exact names or `*.wildcard`.
   */
  allowedHosts: readonly string[];
}

/**
 * One adapter per ATS. Adapters are pure functions over HTTP responses: they fetch,
 * parse, and map into JobPostingInput; they never write state or touch the LLM.
 */
export interface SourceAdapter<RawJob = unknown> {
  readonly source: Ats;
  readonly policy: AdapterPolicy;
  /** Full list of published jobs on the board, light fields. */
  listJobs(board: Board, http: HttpClient): Promise<RawJob[]>;
  /** Only when the list omits the description. */
  fetchDetail?(board: Board, raw: RawJob, http: HttpClient): Promise<RawJob>;
  /** Employer's publish time per the rules in plan section 3.2; null when the ATS has none. */
  /** `now` is the run start; adapters whose timestamps are relative text (Workday) need it. */
  parsePostedAt(raw: RawJob, firstSeenAt: Date, now?: Date): Date | null;
  /** `${source}:${board.board_key}:${externalId}` */
  canonicalKey(raw: RawJob, board: Board): string;
  /** Normalize one raw job into the shared input shape. */
  toInput(raw: RawJob, board: Board, firstSeenAt: Date, now?: Date): JobPostingInput;
}

/** The per-host limits an adapter passes to HttpClient, derived from its policy. */
export function limitsOf(policy: AdapterPolicy): HostLimits {
  return { minDelayMs: policy.minDelayMs, maxConcurrency: policy.maxConcurrencyPerHost };
}
