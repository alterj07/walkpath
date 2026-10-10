# Operations

## The hourly run

`.github/workflows/crawl.yml` runs on `cron: 17 * * * *` (an off-the-hour minute is less
contended) and on `workflow_dispatch`. Scheduled runs execute only from `main`. The
`concurrency: crawl` group with `cancel-in-progress: false` means a late run finishes before the
next one starts; it never overlaps.

| Job | What it does | Budget |
| --- | --- | --- |
| `crawl-api` | Restores `state/state-api.sqlite` from the Actions cache, polls every active Greenhouse, Ashby, Workable and SmartRecruiters board (interleaved across sources, start offset rotating by the hour so boards missed by a deadline go first next hour), diffs, uploads `out/diff-api.json` as the `diff-api` artifact, saves the cache. | 40 min crawl deadline, 50 min job timeout |
| `crawl-lever` | Lever alone, with `state/state-lever.sqlite` and the `diff-lever` artifact. `api.lever.co` is a single host whose robots.txt sets `Crawl-delay: 1`, so the client sends at most one request per second there and ~2,200 boards plus paging need about two hours. The job therefore runs `--shard $((hour % 2))/2`: every board is polled every other hour (boards outside the shard are not polled, never closed). | 45 min crawl deadline, 55 min job timeout |
| `crawl-workday` | Same for Workday tenants with its own state file and the `diff-workday` artifact. Off until the repository variable `WORKDAY_ENABLED` is `true`. Runs with `--detail-cap 40`: 4,072 tenants × ~5 list pages × 2 s at 20 parallel tenants is about 34 minutes before any detail requests, so the first run backfills over several hours and each later run only fetches new postings (see `docs/workday.md`). | 30 min deadline, 45 min timeout |
| `publish` | `needs` the three crawl jobs (runs when `crawl-api` succeeded, even if Lever or Workday failed or was skipped), checks out the `data` branch, downloads the artifacts, restores `state/state-publish.sqlite`, runs `scripts/publish.ts` (gates, summaries, shards, feeds, `meta.json`, alerts), commits the data branch, stages the data into the site, builds it, deploys to Cloudflare Pages when the token is set, and pings the heartbeat. See `docs/deploy.md`. | 12 min summary deadline, 30 min job timeout |

Top-level `permissions` are `contents: read`; only the publish job gets `contents: write` (for the
`data` branch commit).
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
| `SITE_URL` | repository variable | `publish`, `preview` | Canonical origin, e.g. `https://walkpath.pages.dev`; absolute feed/sitemap/canonical URLs. Defaults to the placeholder when unset. |
| `SUPPRESS_ALERTS` | repository variable | `publish` | `true` for one hour after a state restore so re-seen jobs are not re-announced. |
| `PUBLIC_BRANDFETCH_CLIENT_ID` | repository variable | `publish`, `preview` | Brandfetch Logo Link client id (public; baked into the site). Unset → letter avatars. |
| `CLOUDFLARE_PAGES_PROJECT` | repository variable | `publish`, `preview` | Pages project name; defaults to `walkpath`. |
| `CLOUDFLARE_API_TOKEN` | secret | `publish`, `preview` | Token with only *Cloudflare Pages: Edit* on one account. Unset → site built, not deployed. |
| `CLOUDFLARE_ACCOUNT_ID` | secret | `publish`, `preview` | Account id for the Pages deploy and for Workers AI. |
| `MISTRAL_API_KEY` | secret | `publish` | Primary summarizer (Experiment plan). |
| `GEMINI_API_KEY` | secret | `publish` | Fallback summarizer (Gemini Flash-Lite free tier). |
| `CLOUDFLARE_AI_TOKEN` | secret | `publish` | Workers AI token (fallback summarizer, 10k neurons/day). |
| `GROQ_API_KEY` | secret | `publish` | Fallback summarizer. |
| `GITHUB_MODELS_TOKEN` | secret | `publish` | Fine-grained PAT with the `models` permission (last-resort summarizer). |
| `DISCORD_WEBHOOK_URL` | secret | `publish` | Posting-only webhook for the Discord job channel. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | secret | `publish` | Bot token and the broadcast channel id. |
| `BETTERSTACK_HEARTBEAT_URL` | secret | `publish` | Pinged after a fully successful run; the monitor alerts when 90 min pass without one. |
| `VERCEL_DEPLOY_HOOK_URL` | secret | optional; publish job triggers a Vercel rebuild after pushing the data branch |

Missing LLM keys mean "summary pending"; missing alert tokens mean no digest; missing Cloudflare
secrets mean the data branch still updates but the site is not deployed. Every step logs counts
and ids only. `docs/github-settings.md` says where each value comes from.

## State snapshots and recovery

The Actions cache is the only home of the four state files (`state-api`, `state-lever`, `state-workday`,
`state-publish`), and GitHub evicts cache entries unused for 7 days or under pressure. Losing a
state file is not fatal, but a crawl that starts from an empty `jobs_seen` treats every open job
as new and would re-alert everything (plan 12.1).

`.github/workflows/snapshot.yml` runs every Sunday at 04:37 UTC (and on dispatch) in the `crawl`
concurrency group, so it never reads a file mid-write. It restores the newest cache entry of each
prefix, runs `PRAGMA integrity_check`, gzips the file and uploads it to a rolling prerelease
tagged `state-snapshot` through the runner's GitHub CLI (no third-party action). The release holds
one rolling asset per file (`state-api.sqlite.gz`, `state-lever.sqlite.gz`, `state-workday.sqlite.gz`,
`state-publish.sqlite.gz`, always the latest) plus dated copies (`state-api-YYYYMMDD.sqlite.gz`)
kept for 35 days. Sizes, never contents, are printed in the log.

To recover after a cache loss, run `.github/workflows/restore-state.yml` by hand
(**Actions → restore-state → Run workflow**, choose `api`, `workday`, `publish` or `all`). It
downloads the rolling asset, verifies it, and saves it to the cache under
`state-<which>-restore-<run id>`. The hourly run restores by prefix (`state-api-`), and
`restore-keys` pick the most recently created matching entry, so the next run starts from the
snapshot. Everything that happened between the snapshot and the loss is re-discovered as "new"
on that run; to keep those jobs from being announced twice, set the repository variable
`SUPPRESS_ALERTS` to `true` (**Settings → Secrets and variables → Actions → Variables**) before
the next `:17` run and clear it an hour later. The publish job maps that variable to the
orchestrator's `--no-alerts` flag.

You can also restore by hand for local inspection:

```sh
gh release download state-snapshot --pattern 'state-api.sqlite.gz' --dir state
gunzip state/state-api.sqlite.gz
```

## Data branch squash

The publish job commits the JSON shards to the `data` branch every hour: roughly 6 MB of new
JSON a day, and a history nobody reads. `.github/workflows/squash-data.yml` runs on the 1st of
every month at 05:13 UTC (and on dispatch), in the `crawl` group so it never races the publish
job's push. It fetches `data`, creates an orphan commit holding the current tree, and
force-pushes it with `--force-with-lease` (the push is refused if the branch moved meanwhile; the
next month's run tries again). The log prints the commit count before and after and the local
object count after `git gc --prune=now`. GitHub reclaims the unreachable objects on the server on
its own schedule, which is why the repository size in the UI can lag by a few days.

Consequences: anyone who forked or cloned the `data` branch must re-clone it after a squash
(`git fetch origin && git reset --hard origin/data`); `main` is untouched; the weekly snapshot
release remains the archive. A branch protection rule on `data` must allow force pushes from the
Actions bot (or exempt it), otherwise the squash fails with a permissions error and the branch
simply keeps growing until the rule is adjusted (see `docs/github-settings.md`).

To run it by hand: **Actions → squash-data → Run workflow**, or locally:

```sh
git fetch origin data
git checkout -B data origin/data
git checkout --orphan squashed && git add -A && git commit -m "chore(data): manual squash $(date -u +%F)"
git push --force-with-lease=data:$(git rev-parse origin/data) origin squashed:data
```

The `data` branch has to exist before the first publish run. Create it once, empty, from a clean
checkout:

```sh
git switch --orphan data
git commit --allow-empty -m "chore(data): initialise"
git push origin data
git switch main
```

## Logs

Run logs are public. The scripts log through `src/cli/log.ts`, whose redaction guard prints ids,
counts and codes and replaces anything long, prose-like or containing a URL with `[redacted]`.
Adapters never put payload text into error messages.

## Host blocks and the circuit breaker

The first full crawl (2026-10-10) showed what a block looks like: `boards-api.greenhouse.io`
answered 403 to every list and detail request about 70 seconds in, after ~330 boards at 20
concurrent requests, and the run kept sending for 27 minutes. Two things changed:

- The Greenhouse adapter now sends at most 4 concurrent requests with 250 ms between them.
- `HttpClient` has a per-host circuit breaker (plan 10.3): a 403 or an exhausted retry budget
  cools the host down for 2 minutes, then 10, then 30; after three consecutive blocks the circuit
  opens for the rest of the run and every further request to that host fails locally with
  `circuit_open` without being sent. A successful response resets the count. The crawl summary
  logs one `host circuit open` line per host (host and counts only), and `/status` counts the
  boards that failed with `circuit_open` like any other failed fetch: no closures.

A host that stays blocked across runs is the signal to lower that adapter's policy further or to
contact the vendor; the crawler never retries harder, rotates addresses or changes its User-Agent.


## Deadlines, hard stop and artifacts (why an hour can never produce nothing)

Each crawl job has two clocks. At `--deadline-min` it stops starting boards (the ones not
reached are counted as `skipped_deadline` and, because the board order rotates by hour, are
polled first next run). At `--deadline-min + --grace-min` (grace defaults to 3 minutes) it aborts
every request still in flight: those boards are also counted as `skipped_deadline`, never as
failures, their `consecutive_failures` and `last_polled_at` are untouched, and no job is closed
on their account. The artifact is then written and the job exits 0, so the `Upload diff
artifact` step (`if: always()`) always has something to upload. The job `timeout-minutes` is a
backstop several minutes above the hard stop.

| Job | Sources | Soft deadline | Hard stop | Job timeout |
| --- | --- | --- | --- | --- |
| `crawl-api` | Greenhouse (4 concurrent, 250 ms), Ashby, Workable, SmartRecruiters | 38 min | 41 min | 50 min |
| `crawl-lever` | Lever, half the boards each hour (`--shard hour%2/2`), 1 request/s | 43 min | 46 min | 55 min |
| `crawl-workday` | Workday, 1 request per tenant every 2 s, `--detail-cap 40` | 38 min | 41 min | 50 min |
| `publish` | needs all three; runs when at least one succeeded | 12 min for summaries | | 30 min |

Inside a job each source gets its own worker pool: a source on one shared API host runs at most
`2 × maxConcurrencyPerHost` boards at a time (Greenhouse 8, Ashby 20, Workable 10,
SmartRecruiters 16), so the global worker count can never pile up behind one host's rate limit
while the others sit idle. Workday (one host per tenant) keeps the full `--concurrency`.

The crawl summary line reports `aborted` (boards cut off by the hard stop) and `hard_stop`
(whether it fired at all); a healthy hour shows `hard_stop=false`.

## Schedule drift and the backup trigger

GitHub runs `schedule` triggers from a shared queue: a run can start minutes late, and at busy
times some firings are dropped entirely (the first day saw one run in four hours). The workflow
therefore has two cron lines, `17 * * * *` and `47 * * * *`. `concurrency: crawl` with
`cancel-in-progress: false` serialises them, and publish is idempotent, so in a normal hour the
second trigger waits for the first to finish and then finds nothing new (a few minutes of runner
time). In practice this yields about one effective run per hour.

If drift ever matters more than that, the free fix is an external pinger: a Cloudflare Worker
with a cron trigger (5 per account on the free plan) that calls
`POST /repos/alterj07/walkpath/actions/workflows/crawl.yml/dispatches` with a fine-grained
personal access token scoped to this repository with `actions: write`. The token lives in the
Worker's secret store, not in this repository. It is deliberately not implemented here.

## Summaries with no provider key

The publish job has `models: read`, and `GITHUB_MODELS_TOKEN` falls back to the job's own
`GITHUB_TOKEN`, so the GitHub Models provider (`openai/gpt-4o-mini`) works with zero setup.
Its free tier is small (about 150 requests per day on the low tier), enough to keep the queue
moving but not to clear a backlog; the queue drains oldest-first across runs. Add
`MISTRAL_API_KEY` (Experiment plan, 1 billion tokens per month) when you want every new
posting summarized within the hour; the provider order stays Mistral, Gemini, Workers AI,
Groq, GitHub Models.
