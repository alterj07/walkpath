# Architecture

Two places run code: a GitHub Actions workflow (crawl, gate, summarize, build, deploy, alert) and
the visitor's browser (filter, search, saved jobs). Cloudflare only serves files. There is no server
of ours to keep up.

## Hourly run (`.github/workflows/crawl.yml`, cron `17 * * * *`)

| Job | What it does |
| --- | --- |
| `crawl-api` | Restores `state-api.sqlite` from the Actions cache; polls every Greenhouse, Lever, Ashby, Workable, SmartRecruiters board with a per-host token bucket; diffs against `jobs_seen`; uploads `diff-api.json` as an artifact; saves the cache. |
| `crawl-workday` | Same for Workday tenants: 1 concurrent request per tenant, at least 2 s between pages. |
| `publish` | Merges both diffs into the data branch checkout, runs the internship and tech gates, dedup and closures, LLM summaries through the provider chain, writes JSON shards, indexes, feeds and `meta.json`, builds the Astro site, deploys with wrangler, posts Discord and Telegram digests, commits the data branch. |

Concurrency group `crawl` with `cancel-in-progress: false`, so a late run never overlaps the next.
`workflow_dispatch` supports `mode=normal|backfill|regate`.

## How "new job" detection works

There is no push feed from employers. Every board is polled; each job is keyed
`ats:board_key:external_id`; the stored set is diffed:

- **new**: key not seen before. `first_seen_at = now()`. Enrichment and alerts are enqueued.
- **changed**: key seen, 16-byte content hash differs. `updated_at` bumped; no re-alert.
- **missing**: key in store, not in a successful full response. `closed_at = now()`, unless more
  than 50% of the board vanished in one run (treated as a partial fetch; closures withheld).
- A failed request is never a closure. 429/5xx back off exponentially and honour `Retry-After`.

`posted_at` is the employer's timestamp when the ATS gives one (`first_published`, `createdAt`,
`publishedAt`, `published_on`, `releasedDate`); Workday only gives "Posted Today" text, so it is
parsed to date precision; otherwise `posted_at = first_seen_at`. Both timestamps are always stored.
Discovery latency is `first_seen_at - posted_at` and is reported on `/status`.

## Data stores

| Store | Where | Contents |
| --- | --- | --- |
| Registry | `registry/boards.csv` on `main` | One row per board; changed only by reviewed PR |
| State | `state-*.sqlite` in the Actions cache, weekly snapshot on a GitHub Release | `boards_state`, `jobs_seen`, `summaries_pending`, `llm_usage` |
| Published data | `data` branch | `index/latest.json`, `index/7d.json`, `index/all.json`, `jobs/<xx>.json` (256 buckets), `companies.json`, `feeds/*.xml`, `meta.json` |

## Site

Astro static output with one React island (TanStack Table + MiniSearch) for the explore table.
The home page loads `index/latest.json` (last 24 h) first and wider windows on demand. Job pages
render client-side from their bucket file and are `noindex`; category and company pages are
pre-rendered for search engines. Saved/applied state lives in `localStorage` only.

## Free-tier budget

GitHub Actions minutes are unlimited on public repositories with standard runners, which is the one
number that makes hourly runs possible. The LLM budget (Mistral Experiment plan, then Gemini
Flash-Lite, Cloudflare Workers AI, Groq, GitHub Models) is tracked per provider per day in
`llm_usage`; when every quota is hit, jobs publish unsummarized and queue for the next run.
