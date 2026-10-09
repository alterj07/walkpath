# Operations

## The hourly run

`.github/workflows/crawl.yml` runs on `cron: 17 * * * *` (an off-the-hour minute is less
contended) and on `workflow_dispatch`. Scheduled runs execute only from `main`. The
`concurrency: crawl` group with `cancel-in-progress: false` means a late run finishes before the
next one starts; it never overlaps.

| Job | What it does | Budget |
| --- | --- | --- |
| `crawl-api` | Restores `state/state-api.sqlite` from the Actions cache, polls every active Greenhouse, Lever, Ashby, Workable and SmartRecruiters board, diffs, uploads `out/diff-api.json` as the `diff-api` artifact, saves the cache. | 25 min crawl deadline, 40 min job timeout |
| `crawl-workday` | Same for Workday tenants with its own state file and the `diff-workday` artifact. Off until the repository variable `WORKDAY_ENABLED` is `true`. Runs with `--detail-cap 40`: 4,072 tenants × ~5 list pages × 2 s at 20 parallel tenants is about 34 minutes before any detail requests, so the first run backfills over several hours and each later run only fetches new postings (see `docs/workday.md`). | 30 min deadline, 45 min timeout |
| `publish` | Not yet in the workflow. It will `needs` both crawl jobs, download the artifacts, gate and summarize, write the data branch, build and deploy the site. | |

Top-level `permissions` are `contents: read`; only the future publish job gets `contents: write`.
Every action is pinned to a commit SHA (verified against the tag through the GitHub API).

## Running locally

```sh
npm ci
node packages/pipeline/scripts/crawl.ts \
  --boards registry/sample.csv --sources registry/sources.json \
  --state state/local.sqlite --out out/diff-local.json --concurrency 10
```

`registry/sample.csv` holds 25 boards (5 per API-backed ATS). The sample run takes about half a
minute, writes roughly 2,000 events on the first pass and 0 on the second (the state file
remembers what it has seen). `state/` and `out/` are git-ignored.

Flags: `--ats a,b` (which sources; default the five API sources), `--limit N` (first N boards),
`--concurrency N` (boards in flight; per-host politeness is enforced separately by the HTTP
client), `--deadline-min N` (see below), `--mode normal|backfill`.

Exit code 0 means the run completed, even when some boards failed (failures are in the artifact
and in `boards_state.consecutive_failures`). Exit code 1 means the registry was invalid, the
state file could not be opened, nothing could be polled, or every polled board failed.

SmartRecruiters boards fail with `error` until `SMARTRECRUITERS_API_KEY` is set; the adapter
refuses to call that API without a key (plan 10.2), so those boards count as failed, not closed.

## State: one SQLite file in the Actions cache

Each crawl job keeps its state (`boards_state`, `jobs_seen`, `summaries_pending`, `llm_usage`,
`run_log`) in a single `.sqlite` file. The file uses the rollback journal (`journal_mode = DELETE`),
not WAL, so there are never `-wal`/`-shm` side files that the cache step could miss. The cache
key is `state-api-<run id>` with a `state-api-` restore prefix, so every run restores the newest
previous state and saves a new entry; the save step runs with `if: always()` so a crawl that hits
its deadline still persists what it learned. Entries unused for 7 days are evicted; hourly runs
keep them warm. A weekly snapshot attached to a GitHub Release is the recovery point when the
cache is lost (planned for the hardening feature).

The script closes the database in a `finally` block and on `SIGTERM`/`SIGINT`, so the job
timeout cannot leave a half-written journal behind.

## Deadline behaviour

`--deadline-min N` starts a wall-clock timer when the script starts. Once it fires, no further
board is started; boards already in flight finish normally. Boards not reached are counted as
`boards.skipped_deadline` in the artifact (never as failures) and are polled first next hour,
because the board order is the registry order. The 45-day stale closure and the 90-day prune run
after the crawl regardless.

## Dispatch modes

| Mode | Crawl jobs | Meaning |
| --- | --- | --- |
| `normal` | run | The hourly behaviour. |
| `backfill` | run with `--mode backfill` | Every listed job is re-fetched with full detail and re-emitted as a `changed` event, with the per-board detail cap lifted, so the publish job rewrites every record. Use after a schema or sanitizer change. Costs one detail request per job on Greenhouse/SmartRecruiters. |
| `regate` | skipped | Crawl jobs do nothing; the publish job re-runs the rule gates over `jobs_seen` without LLM calls (handled by the publish feature). |

Under the hood `backfill` sets `forceRefresh: true` and `detailCap: Number.MAX_SAFE_INTEGER` on
`crawlBoards`, which `diffBoard` honours by treating every existing key as needing detail and by
emitting it as `changed` even when its content hash is unchanged. Closures are unaffected.

## The artifacts

`diff-api.json` / `diff-workday.json` is one `CrawlReport` (see `src/crawl/run.ts`): run id, start
and finish, per-ATS board and job counts, `events` (every new, changed and repost job with its
normalized input and a 64 KB-capped description), `closed_keys`, `reopened_keys`, `failures`
(board id and error code) and `needs_refingerprint` (boards that failed 3 runs in a row). A busy
hour is tens of MB, so the artifact keeps `retention-days: 1`.

## Disabling a source

Set `"enabled": false` for the ATS in `registry/sources.json` and merge; the next run skips every
board of that source (its jobs are neither polled nor closed). `"publish": {"enabled": false}`
is the kill switch for the publish step. To drop a single board, set its `status` to `disabled`
in `registry/boards.csv`.

## Secrets and variables

| Name | Kind | Used by | Purpose |
| --- | --- | --- | --- |
| `SMARTRECRUITERS_API_KEY` | secret | `crawl-api` | Free developer key for the SmartRecruiters posting API; without it the source is skipped. |
| `WORKDAY_ENABLED` | repository variable | `crawl-workday` | `true` turns the Workday job on after the tolerance test. |

The publish feature adds the LLM keys, the Cloudflare token, the Discord webhook, the Telegram
bot token and the heartbeat URL; they are documented when they land.

## Logs

Run logs are public. The scripts log through `src/cli/log.ts`, whose redaction guard prints ids,
counts and codes and replaces anything long, prose-like or containing a URL with `[redacted]`.
Adapters never put payload text into error messages.
