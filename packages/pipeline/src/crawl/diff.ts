import type { SourceAdapter } from '../adapters/types.ts';
import type { HttpClient } from '../http/client.ts';
import { HttpError } from '../http/client.ts';
import { contentHash, jobIdFromKey } from '../ids.ts';
import { boardId as boardIdOf, type Board } from '../schema/board.ts';
import type { Ats, PostedAtSource } from '../schema/common.ts';
import type { JobPostingInput } from '../schema/job.ts';
import type { BoardStateRow, JobSeenRow, StateDb } from '../state/db.ts';

/**
 * Turns one board's live job list into insert / update / close events against
 * `jobs_seen` (plan sections 3.3, 4.6 layer 1, 4.7). Pure over the adapter's output;
 * never calls the LLM and never closes anything on a failed fetch or a failed mapping.
 */

export type JobEventKind = 'new' | 'changed' | 'repost';

export interface JobEvent {
  kind: JobEventKind;
  canonical_key: string;
  job_id: string;
  board_id: string;
  ats: Ats;
  board_key: string;
  input: JobPostingInput;
  posted_at: string;
  posted_at_source: PostedAtSource;
  first_seen_at: string;
  content_hash: string;
  internal_req_id: string | null;
}

export interface DiffCounts {
  listed: number;
  new: number;
  changed: number;
  unchanged: number;
  missing: number;
  closed: number;
  reopened: number;
  reposts: number;
  detail_fetched: number;
  detail_deferred: number;
}

export interface BoardDiff {
  board_id: string;
  ats: Ats;
  ok: boolean;
  /** True when the 50% guard withheld closures (plan 3.3 step 4). */
  partial: boolean;
  /** HttpError code, 'invalid_job', 'state_error' or 'error' when ok is false. */
  error: string | null;
  /** Value after this run, so the runner can flag boards without re-reading state. */
  consecutive_failures: number;
  counts: DiffCounts;
  new: JobEvent[];
  changed: JobEvent[];
  reposts: JobEvent[];
  closed: string[];
  reopened: string[];
}

export interface DiffBoardOptions {
  board: Board;
  adapter: SourceAdapter;
  http: HttpClient;
  db: StateDb;
  now?: () => Date;
  log?: (message: string) => void;
  /** Detail fetches per board per run; the rest wait for the next run. */
  detailCap?: number;
  /**
   * Backfill mode (plan 8.2): re-emit every listed job as `changed` with a fresh detail
   * fetch even when its hash is unchanged. Closures and new/repost logic are untouched.
   */
  forceRefresh?: boolean;
}

/**
 * Per-board cap on `fetchDetail` calls in one run. A brand-new Greenhouse board with
 * 2,000 jobs would otherwise cost 2,000 requests in a single hour; above the cap the
 * remaining new jobs are simply not inserted this run and arrive as new next run, and
 * changed jobs keep their old hash so they are re-examined next run. Nothing is lost,
 * it is just spread over a few hours.
 */
export const DEFAULT_DETAIL_CAP = 200;

/** After this many consecutive partial fetches the shrink is real and closures are accepted. */
export const PARTIAL_STREAK_LIMIT = 3;

/** A repost may inherit from an original that is open or closed at most this long. */
export const REPOST_MAX_CLOSED_DAYS = 30;

/** Description bytes kept in the diff artifact; the publish job caps the published HTML at 20 KB anyway. */
export const EVENT_DESCRIPTION_MAX_CHARS = 64 * 1024;

const emptyCounts = (): DiffCounts => ({
  listed: 0,
  new: 0,
  changed: 0,
  unchanged: 0,
  missing: 0,
  closed: 0,
  reopened: 0,
  reposts: 0,
  detail_fetched: 0,
  detail_deferred: 0,
});

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

function hashOf(input: JobPostingInput, description: string | null): string {
  return contentHash({
    title: input.title,
    locations: input.locations,
    department: input.department ?? null,
    employmentType: input.employmentType ?? null,
    remoteFlag: input.remoteFlag ?? null,
    applyUrl: input.applyUrl,
    // Derived dates (Workday "Posted N Days Ago", first-seen fallbacks) are not content:
    // they would change on every run and force a detail re-fetch per posting per day.
    postedAt: input.postedAtSource === 'ATS_FIELD' ? input.postedAt : null,
    description,
  });
}

/**
 * Light lists omit the description, so a description-only edit would be invisible.
 * Greenhouse bumps `updated_at` on any edit; when the raw job carries such a field we
 * fold it into the light hash in the description slot so edits still trigger a detail
 * fetch (plan 3.3 step 5). SmartRecruiters' list has no updated_at, so on that source a
 * description-only edit is not detected until some list field changes; title, location,
 * department and employment type edits are.
 */
function lightVersion(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  for (const key of ['updated_at', 'updatedAt']) {
    const v = r[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function errorCode(err: unknown): string {
  if (err instanceof HttpError) return err.code;
  return 'error';
}

/** The artifact is uploaded to Actions every hour; keep each event bounded. */
function capDescription(input: JobPostingInput): JobPostingInput {
  if (input.descriptionHtml.length <= EVENT_DESCRIPTION_MAX_CHARS) return input;
  return { ...input, descriptionHtml: input.descriptionHtml.slice(0, EVENT_DESCRIPTION_MAX_CHARS) };
}

function isRepostCandidate(original: JobSeenRow, nowMs: number): boolean {
  if (original.closed_at === null) return true;
  return nowMs - Date.parse(original.closed_at) <= REPOST_MAX_CLOSED_DAYS * 86_400_000;
}

/** Diff one board against the state store and persist the result in one transaction. */
export async function diffBoard(opts: DiffBoardOptions): Promise<BoardDiff> {
  const { board, adapter, http, db } = opts;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const detailCap = opts.detailCap ?? DEFAULT_DETAIL_CAP;
  const forceRefresh = opts.forceRefresh ?? false;
  const id = boardIdOf(board);
  const startedAt = now();
  const nowIso = startedAt.toISOString();
  const nowMs = startedAt.getTime();
  const state: BoardStateRow = db.getBoardState(id) ?? {
    board_id: id,
    last_polled_at: null,
    last_success_at: null,
    consecutive_failures: 0,
    job_count_last: null,
    partial_streak: 0,
    etag: null,
    last_modified: null,
  };

  const diff: BoardDiff = {
    board_id: id,
    ats: board.ats,
    ok: false,
    partial: false,
    error: null,
    consecutive_failures: state.consecutive_failures,
    counts: emptyCounts(),
    new: [],
    changed: [],
    reposts: [],
    closed: [],
    reopened: [],
  };

  const fail = (code: string): BoardDiff => {
    if (code === 'aborted') {
      // The run's hard deadline cut this board off mid-request: not a board failure, nothing
      // learned, nothing written (last_polled_at and consecutive_failures stay as they were).
      diff.ok = false;
      diff.partial = false;
      diff.error = 'aborted';
      diff.consecutive_failures = state.consecutive_failures;
      diff.new = [];
      diff.changed = [];
      diff.reposts = [];
      diff.closed = [];
      diff.reopened = [];
      diff.counts = emptyCounts();
      log(`board ${id}: aborted (deadline)`);
      return diff;
    }
    const failures = state.consecutive_failures + 1;
    diff.ok = false;
    diff.partial = false;
    diff.error = code;
    diff.consecutive_failures = failures;
    diff.new = [];
    diff.changed = [];
    diff.reposts = [];
    diff.closed = [];
    diff.reopened = [];
    diff.counts = emptyCounts();
    try {
      db.upsertBoardState({ ...state, last_polled_at: nowIso, consecutive_failures: failures });
    } catch {
      // State itself is unwritable; the run report still records the failure.
    }
    log(`board ${id}: failed (${code}), failures=${failures}`);
    return diff;
  };

  let raws: unknown[];
  try {
    raws = await adapter.listJobs(board, http);
  } catch (err) {
    return fail(errorCode(err));
  }

  try {
    return await classify();
  } catch (err) {
    return fail(err instanceof StateWriteError ? 'state_error' : 'invalid_job');
  }

  async function classify(): Promise<BoardDiff> {
    const existingRows = db.getJobsForBoard(id);
    const existing = new Map<string, JobSeenRow>(existingRows.map((r) => [r.canonical_key, r]));
    const byReq = new Map<string, JobSeenRow>();
    for (const r of existingRows) {
      if (r.internal_req_id !== null && r.title !== null) {
        byReq.set(`${r.internal_req_id}\u0000${normalizeTitle(r.title)}`, r);
      }
    }

    const seenKeys = new Set<string>();
    const upserts: JobSeenRow[] = [];
    const unchangedKeys: string[] = [];
    const reopenedKeys: string[] = [];
    let detailFetched = 0;

    for (const raw of raws) {
      const key = adapter.canonicalKey(raw, board);
      if (seenKeys.has(key)) continue; // duplicate ids inside one response
      seenKeys.add(key);
      const prior = existing.get(key) ?? null;
      const firstSeenAt = prior === null ? startedAt : new Date(prior.first_seen_at);

      let input = adapter.toInput(raw, board, firstSeenAt, startedAt);
      let fullHash: string;

      if (adapter.fetchDetail !== undefined) {
        const lightHash = hashOf(input, lightVersion(raw));
        // New, edited (light fields or version changed), or closed-and-back: fetch the description.
        const needsDetail = forceRefresh || prior === null || prior.closed_at !== null || prior.content_hash !== lightHash;
        if (!needsDetail) {
          unchangedKeys.push(key);
          continue;
        }
        if (detailFetched >= detailCap) {
          diff.counts.detail_deferred += 1;
          if (prior !== null) unchangedKeys.push(key);
          continue;
        }
        let detailed: unknown;
        try {
          detailed = await adapter.fetchDetail(board, raw, http);
          detailFetched += 1;
        } catch (err) {
          // A failed detail is not a closure and not a change; try again next run.
          log(`board ${id}: detail fetch failed (${errorCode(err)})`);
          if (prior !== null) unchangedKeys.push(key);
          continue;
        }
        input = adapter.toInput(detailed, board, firstSeenAt, startedAt);
        // Store the light hash (list fields + version) so next run's light comparison matches.
        fullHash = lightHash;
      } else {
        fullHash = hashOf(input, input.descriptionHtml);
      }
      input = capDescription(input);

      const internalReqId = input.internalReqId ?? null;
      const titleNorm = normalizeTitle(input.title);

      if (prior === null) {
        // Repost detection (plan 4.6 layer 1): same requisition + title on the same board,
        // original open or closed within REPOST_MAX_CLOSED_DAYS.
        const candidate = internalReqId === null ? undefined : byReq.get(`${internalReqId}\u0000${titleNorm}`);
        const original = candidate !== undefined && isRepostCandidate(candidate, nowMs) ? candidate : undefined;
        const kind: JobEventKind = original === undefined ? 'new' : 'repost';
        const firstSeenIso = original === undefined ? nowIso : original.first_seen_at;
        let postedAt: string;
        let postedSource: PostedAtSource;
        if (input.postedAt === null) {
          postedAt = firstSeenIso;
          postedSource = 'FIRST_SEEN';
        } else if (input.postedAt <= firstSeenIso) {
          postedAt = input.postedAt;
          postedSource = input.postedAtSource;
        } else {
          postedAt = firstSeenIso; // plan 3.2 "Any": never later than first seen
          postedSource = 'FIRST_SEEN';
        }
        if (original !== undefined && original.posted_at !== null && original.posted_at < postedAt) {
          postedAt = original.posted_at;
          postedSource = original.posted_at_source ?? 'FIRST_SEEN';
        }
        const event: JobEvent = {
          kind,
          canonical_key: key,
          job_id: jobIdFromKey(key),
          board_id: id,
          ats: board.ats,
          board_key: board.board_key,
          input,
          posted_at: postedAt,
          posted_at_source: postedSource,
          first_seen_at: firstSeenIso,
          content_hash: fullHash,
          internal_req_id: internalReqId,
        };
        (kind === 'new' ? diff.new : diff.reposts).push(event);
        upserts.push({
          canonical_key: key,
          job_id: event.job_id,
          internal_req_id: internalReqId,
          content_hash: fullHash,
          posted_at: postedAt,
          posted_at_source: postedSource,
          first_seen_at: firstSeenIso,
          last_seen_at: nowIso,
          closed_at: null,
          gate: null,
          gate_source: null,
          board_id: id,
          title: input.title,
          apply_url: input.applyUrl,
        });
        continue;
      }

      const wasClosed = prior.closed_at !== null;
      if (wasClosed) reopenedKeys.push(key);
      if (prior.content_hash === fullHash && !wasClosed && !forceRefresh) {
        unchangedKeys.push(key);
        continue;
      }
      // Changed (or reopened: republished so the publish job gets the latest fields).
      let postedAt = prior.posted_at ?? prior.first_seen_at;
      let postedSource: PostedAtSource = prior.posted_at_source ?? 'FIRST_SEEN';
      if (input.postedAt !== null && input.postedAt < postedAt) {
        postedAt = input.postedAt;
        postedSource = input.postedAtSource;
      }
      if (postedAt > prior.first_seen_at) {
        postedAt = prior.first_seen_at;
        postedSource = 'FIRST_SEEN';
      }
      const event: JobEvent = {
        kind: 'changed',
        canonical_key: key,
        job_id: prior.job_id,
        board_id: id,
        ats: board.ats,
        board_key: board.board_key,
        input,
        posted_at: postedAt,
        posted_at_source: postedSource,
        first_seen_at: prior.first_seen_at,
        content_hash: fullHash,
        internal_req_id: internalReqId ?? prior.internal_req_id,
      };
      diff.changed.push(event);
      upserts.push({
        ...prior,
        internal_req_id: event.internal_req_id,
        content_hash: fullHash,
        posted_at: postedAt,
        posted_at_source: postedSource,
        last_seen_at: nowIso,
        closed_at: null,
        title: input.title,
        apply_url: input.applyUrl,
      });
    }

    // Missing = open rows not in this response.
    const missing: string[] = [];
    for (const r of existingRows) {
      if (r.closed_at === null && !seenKeys.has(r.canonical_key)) missing.push(r.canonical_key);
    }
    const lastCount = state.job_count_last ?? 0;
    const looksPartial = lastCount > 0 && (raws.length === 0 || missing.length > 0.5 * lastCount);
    // A small board shrinking (3 → 1, 1 → 0) always looks partial; after PARTIAL_STREAK_LIMIT
    // consecutive partial fetches the shrink is accepted as real.
    const streak = looksPartial ? state.partial_streak + 1 : 0;
    const partial = looksPartial && streak < PARTIAL_STREAK_LIMIT;
    const toClose = partial ? [] : missing;

    diff.ok = true;
    diff.partial = partial;
    diff.consecutive_failures = 0;
    diff.closed = toClose;
    diff.reopened = reopenedKeys;
    diff.counts = {
      listed: seenKeys.size,
      new: diff.new.length,
      changed: diff.changed.length,
      unchanged: unchangedKeys.length,
      missing: missing.length,
      closed: toClose.length,
      reopened: reopenedKeys.length,
      reposts: diff.reposts.length,
      detail_fetched: detailFetched,
      detail_deferred: diff.counts.detail_deferred,
    };

    try {
      db.withTransaction(() => {
        db.upsertJobs(upserts);
        db.touchLastSeen(unchangedKeys, nowIso);
        db.markClosed(toClose, nowIso);
        db.upsertBoardState({
          board_id: id,
          last_polled_at: nowIso,
          last_success_at: nowIso,
          consecutive_failures: 0,
          // Counts every listed job, including new ones whose detail was deferred, because
          // the next list will contain them again; the guard compares list sizes.
          job_count_last: partial ? state.job_count_last : seenKeys.size,
          partial_streak: partial ? streak : 0,
          etag: state.etag,
          last_modified: state.last_modified,
        });
      });
    } catch (err) {
      throw new StateWriteError(err);
    }

    log(
      `board ${id}: listed=${diff.counts.listed} new=${diff.counts.new} changed=${diff.counts.changed} closed=${diff.counts.closed}` +
        `${partial ? ` PARTIAL(${streak})` : ''}${diff.counts.detail_deferred > 0 ? ` deferred=${diff.counts.detail_deferred}` : ''}`,
    );
    return diff;
  }
}

class StateWriteError extends Error {
  constructor(cause: unknown) {
    super('state write failed', { cause });
    this.name = 'StateWriteError';
  }
}

/** Safety TTL (plan 4.7): close open jobs not reconfirmed for `days`. Returns closed keys. */
export function closeStale(db: StateDb, now: Date, days = 45): string[] {
  const before = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  return db.closeStaleBefore(before, now.toISOString());
}

/** Retention (plan 6.2): drop rows closed more than `days` ago. Returns the number pruned. */
export function pruneClosed(db: StateDb, now: Date, days = 90): number {
  const before = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  return db.pruneClosedBefore(before);
}
