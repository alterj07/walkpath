import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { PostedAtSource } from '../schema/common.ts';

/**
 * The crawl state store (plan section 6.2). One SQLite file per crawl job, restored from
 * the Actions cache before a run and saved after it. All SQL lives in this file; callers
 * use the typed methods below.
 */

export type Gate = 'tech_intern' | 'not_intern' | 'not_tech' | 'ambiguous' | 'pending';
export type GateSource = 'rule' | 'llm';

export interface BoardStateRow {
  board_id: string;
  last_polled_at: string | null;
  last_success_at: string | null;
  consecutive_failures: number;
  job_count_last: number | null;
  /** Consecutive successful-but-partial fetches (the 50% guard); closures are accepted after 3. */
  partial_streak: number;
  etag: string | null;
  last_modified: string | null;
}

export interface JobSeenRow {
  canonical_key: string;
  job_id: string;
  internal_req_id: string | null;
  content_hash: string;
  posted_at: string | null;
  posted_at_source: PostedAtSource | null;
  first_seen_at: string;
  last_seen_at: string;
  closed_at: string | null;
  gate: Gate | null;
  gate_source: GateSource | null;
  board_id: string;
  title: string | null;
  apply_url: string | null;
}

export interface SummaryPendingRow {
  job_id: string;
  attempts: number;
  queued_at: string;
}

export interface LlmUsageRow {
  day: string;
  provider: string;
  requests: number;
  tokens: number;
}

export interface RunLogRow {
  run_id: string;
  started_at: string;
  finished_at: string | null;
  kind: string;
  stats_json: string | null;
}

const SCHEMA_VERSION = 2;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE IF NOT EXISTS boards_state (
      board_id TEXT PRIMARY KEY,
      last_polled_at TEXT,
      last_success_at TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      job_count_last INTEGER,
      etag TEXT,
      last_modified TEXT
    );
    CREATE TABLE IF NOT EXISTS jobs_seen (
      canonical_key TEXT PRIMARY KEY,
      job_id TEXT NOT NULL UNIQUE,
      internal_req_id TEXT,
      content_hash TEXT NOT NULL,
      posted_at TEXT,
      posted_at_source TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      closed_at TEXT,
      gate TEXT,
      gate_source TEXT,
      board_id TEXT NOT NULL,
      title TEXT,
      apply_url TEXT
    );
    CREATE INDEX IF NOT EXISTS jobs_seen_board_id ON jobs_seen(board_id);
    CREATE INDEX IF NOT EXISTS jobs_seen_closed_at ON jobs_seen(closed_at);
    CREATE TABLE IF NOT EXISTS summaries_pending (
      job_id TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      queued_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_usage (
      day TEXT NOT NULL,
      provider TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, provider)
    );
    CREATE TABLE IF NOT EXISTS run_log (
      run_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      kind TEXT NOT NULL,
      stats_json TEXT
    );
  `,
  2: `
    ALTER TABLE boards_state ADD COLUMN partial_streak INTEGER NOT NULL DEFAULT 0;
  `,
};

export class StateDb {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private transactionDepth = 0;

  constructor(path: string) {
    this.path = path;
    this.db = new DatabaseSync(path);
    // Single writer, single file. The Actions cache stores exactly one .sqlite file per crawl
    // job; WAL would leave -wal/-shm side files that the cache would miss if the process
    // exited without close(), so the rollback journal (DELETE) is used instead.
    this.db.exec('PRAGMA journal_mode = DELETE');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.migrate();
  }

  // ---- lifecycle -------------------------------------------------------------

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
    let current = row?.version ?? 0;
    this.withTransaction(() => {
      while (current < SCHEMA_VERSION) {
        const next = current + 1;
        const sql = MIGRATIONS[next];
        if (sql === undefined) throw new Error(`state: missing migration ${next}`);
        this.db.exec(sql);
        current = next;
      }
      if (row === undefined) {
        this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(current);
      } else {
        this.db.prepare('UPDATE schema_version SET version = ?').run(current);
      }
    });
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }

  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (s === undefined) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  /** Runs fn inside a transaction; nested calls join the outer one. */
  withTransaction<T>(fn: () => T): T {
    if (this.transactionDepth > 0) {
      this.transactionDepth += 1;
      try {
        return fn();
      } finally {
        this.transactionDepth -= 1;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth = 1;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.transactionDepth = 0;
    }
  }

  // ---- boards_state -----------------------------------------------------------

  getBoardState(boardId: string): BoardStateRow | null {
    const row = this.stmt('SELECT * FROM boards_state WHERE board_id = ?').get(boardId) as BoardStateRow | undefined;
    return row ?? null;
  }

  upsertBoardState(row: BoardStateRow): void {
    this.stmt(
      `INSERT INTO boards_state (board_id, last_polled_at, last_success_at, consecutive_failures, job_count_last, partial_streak, etag, last_modified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(board_id) DO UPDATE SET
         last_polled_at = excluded.last_polled_at,
         last_success_at = excluded.last_success_at,
         consecutive_failures = excluded.consecutive_failures,
         job_count_last = excluded.job_count_last,
         partial_streak = excluded.partial_streak,
         etag = excluded.etag,
         last_modified = excluded.last_modified`,
    ).run(
      row.board_id,
      row.last_polled_at,
      row.last_success_at,
      row.consecutive_failures,
      row.job_count_last,
      row.partial_streak,
      row.etag,
      row.last_modified,
    );
  }

  // ---- jobs_seen ----------------------------------------------------------------

  getJob(canonicalKey: string): JobSeenRow | null {
    const row = this.stmt('SELECT * FROM jobs_seen WHERE canonical_key = ?').get(canonicalKey) as JobSeenRow | undefined;
    return row ?? null;
  }

  getJobById(jobId: string): JobSeenRow | null {
    const row = this.stmt('SELECT * FROM jobs_seen WHERE job_id = ?').get(jobId) as JobSeenRow | undefined;
    return row ?? null;
  }

  getJobsForBoard(boardId: string): JobSeenRow[] {
    return this.stmt('SELECT * FROM jobs_seen WHERE board_id = ?').all(boardId) as unknown as JobSeenRow[];
  }

  countOpenJobs(): number {
    const row = this.stmt('SELECT COUNT(*) AS c FROM jobs_seen WHERE closed_at IS NULL').get() as { c: number };
    return row.c;
  }

  upsertJobs(rows: readonly JobSeenRow[]): void {
    if (rows.length === 0) return;
    const s = this.stmt(
      `INSERT INTO jobs_seen (canonical_key, job_id, internal_req_id, content_hash, posted_at, posted_at_source,
         first_seen_at, last_seen_at, closed_at, gate, gate_source, board_id, title, apply_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(canonical_key) DO UPDATE SET
         internal_req_id = excluded.internal_req_id,
         content_hash = excluded.content_hash,
         posted_at = excluded.posted_at,
         posted_at_source = excluded.posted_at_source,
         first_seen_at = excluded.first_seen_at,
         last_seen_at = excluded.last_seen_at,
         closed_at = excluded.closed_at,
         gate = excluded.gate,
         gate_source = excluded.gate_source,
         board_id = excluded.board_id,
         title = excluded.title,
         apply_url = excluded.apply_url`,
    );
    this.withTransaction(() => {
      for (const r of rows) {
        s.run(
          r.canonical_key,
          r.job_id,
          r.internal_req_id,
          r.content_hash,
          r.posted_at,
          r.posted_at_source,
          r.first_seen_at,
          r.last_seen_at,
          r.closed_at,
          r.gate,
          r.gate_source,
          r.board_id,
          r.title,
          r.apply_url,
        );
      }
    });
  }

  /** Sets closed_at on open rows only; already-closed rows keep their original closed_at. */
  markClosed(keys: readonly string[], at: string): void {
    if (keys.length === 0) return;
    const s = this.stmt('UPDATE jobs_seen SET closed_at = ? WHERE canonical_key = ? AND closed_at IS NULL');
    this.withTransaction(() => {
      for (const k of keys) s.run(at, k);
    });
  }

  reopen(keys: readonly string[], lastSeenAt: string): void {
    if (keys.length === 0) return;
    const s = this.stmt('UPDATE jobs_seen SET closed_at = NULL, last_seen_at = ? WHERE canonical_key = ?');
    this.withTransaction(() => {
      for (const k of keys) s.run(lastSeenAt, k);
    });
  }

  touchLastSeen(keys: readonly string[], lastSeenAt: string): void {
    if (keys.length === 0) return;
    const s = this.stmt('UPDATE jobs_seen SET last_seen_at = ? WHERE canonical_key = ?');
    this.withTransaction(() => {
      for (const k of keys) s.run(lastSeenAt, k);
    });
  }

  setGate(canonicalKey: string, gate: Gate, source: GateSource): void {
    this.stmt('UPDATE jobs_seen SET gate = ?, gate_source = ? WHERE canonical_key = ?').run(gate, source, canonicalKey);
  }

  /** Open rows not reconfirmed since `before` (the 45-day safety TTL, plan 4.7). Returns the closed keys. */
  closeStaleBefore(before: string, at: string): string[] {
    const rows = this.stmt('SELECT canonical_key FROM jobs_seen WHERE closed_at IS NULL AND last_seen_at < ?').all(before) as {
      canonical_key: string;
    }[];
    const keys = rows.map((r) => r.canonical_key);
    this.markClosed(keys, at);
    return keys;
  }

  /** Deletes rows closed before `before` (plan 6.2: closed > 90 days). Returns the number deleted. */
  pruneClosedBefore(before: string): number {
    const result = this.stmt('DELETE FROM jobs_seen WHERE closed_at IS NOT NULL AND closed_at < ?').run(before);
    return Number(result.changes);
  }

  // ---- summaries_pending -----------------------------------------------------

  enqueueSummary(jobId: string, queuedAt: string): void {
    this.stmt('INSERT OR IGNORE INTO summaries_pending (job_id, attempts, queued_at) VALUES (?, 0, ?)').run(jobId, queuedAt);
  }

  dequeueSummaries(limit: number): SummaryPendingRow[] {
    return this.stmt('SELECT * FROM summaries_pending ORDER BY queued_at ASC, job_id ASC LIMIT ?').all(limit) as unknown as SummaryPendingRow[];
  }

  bumpAttempts(jobId: string): void {
    this.stmt('UPDATE summaries_pending SET attempts = attempts + 1 WHERE job_id = ?').run(jobId);
  }

  removeSummary(jobId: string): void {
    this.stmt('DELETE FROM summaries_pending WHERE job_id = ?').run(jobId);
  }

  countPendingSummaries(): number {
    const row = this.stmt('SELECT COUNT(*) AS c FROM summaries_pending').get() as { c: number };
    return row.c;
  }

  // ---- llm_usage -------------------------------------------------------------

  addLlmUsage(day: string, provider: string, requests: number, tokens: number): void {
    this.stmt(
      `INSERT INTO llm_usage (day, provider, requests, tokens) VALUES (?, ?, ?, ?)
       ON CONFLICT(day, provider) DO UPDATE SET requests = requests + excluded.requests, tokens = tokens + excluded.tokens`,
    ).run(day, provider, requests, tokens);
  }

  getLlmUsage(day: string): LlmUsageRow[] {
    return this.stmt('SELECT * FROM llm_usage WHERE day = ? ORDER BY provider').all(day) as unknown as LlmUsageRow[];
  }

  // ---- run_log -----------------------------------------------------------------

  logRun(row: RunLogRow): void {
    this.stmt(
      `INSERT INTO run_log (run_id, started_at, finished_at, kind, stats_json) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET finished_at = excluded.finished_at, stats_json = excluded.stats_json`,
    ).run(row.run_id, row.started_at, row.finished_at, row.kind, row.stats_json);
  }

  recentRuns(limit: number): RunLogRow[] {
    return this.stmt('SELECT * FROM run_log ORDER BY started_at DESC LIMIT ?').all(limit) as unknown as RunLogRow[];
  }
}

export function openState(path: string): StateDb {
  return new StateDb(path);
}
