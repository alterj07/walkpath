# Publish job

The publish step turns the crawl artifacts into the files the site serves. It runs once per hour
after `crawl-api` and `crawl-workday`, and can be run locally against `out/`:

```sh
node packages/pipeline/scripts/publish.ts \
  --data data --artifacts out/diff-api.json,out/diff-workday.json \
  --boards registry/boards.csv --sources registry/sources.json \
  --state state/state-publish.sqlite --site-url https://walkpath.pages.dev \
  [--deadline-min 12] [--mode normal|regate] [--no-alerts] [--summary-cap 1500]
```

## Flow

1. **Read artifacts.** Each `diff-*.json` is validated against the crawl report schema. A missing
   artifact is skipped with a warning (the Workday job may be disabled). An artifact that fails the
   schema is also skipped with a warning rather than failing the run; its closures are withheld
   until a valid artifact arrives, which is the same safe behaviour as a failed fetch.
2. **Merge events** (`src/publish/merge.ts`). For every new, changed or reposted job:
   - `normalizeTitle`, then the rule gates (`internshipGate`, `techGate`). A hard negative on either
     side drops the job (`not_intern`, `not_tech`); both positive publishes it; anything else is
     `ambiguous` and waits for the LLM gate.
   - The published record (plan 6.3) is built from the registry board and the event: location via
     the gazetteer, arrangement, season, salary, work authorization, graduation years, the
     sanitized description (20 KB cap, allowlist only), and the apply URL via `resolveApplyUrl`
     (off-host or invalid links fall back to the board's careers page and are flagged).
   - Non-US locations (`country === 'other'`) are counted and not stored. Unknown locations are
     published and their raw strings collected in `review/locations.json`.
   - The scam screen holds a job (`review/held.json`, ids and signals only) instead of storing it.
   - Multi-location fan-out: a new job whose title matches an open record on the same board is
     folded into that record's `location.others`; `grouped.json` maps each folded id to
     `{canonical, location}`. When the canonical posting closes while sibling locations are still
     open, the record stays open, the closed location is dropped and the first open sibling's
     location becomes the primary; the record closes only when the last location closes. (The
     record's apply link still points at the original posting; the detail page should prefer the
     careers URL once the original is closed.)
   - A job the LLM gate rejected (`gate_source = llm`) is not re-summarized when the same content
     is delivered again; a changed content hash re-enters the gate.
   - Changed jobs keep their summary, `first_seen_at` and the LLM-derived fields the rules cannot
     determine. Closures set `closed_at`; reopenings clear it. Job ids are derived from the
     canonical key, so closures need no lookup.
3. **Regate** (`--mode regate`) re-runs the rule gates on every stored and pending record without
   LLM calls: use it after changing the keyword lists. Stored records were already admitted as
   internships, so the rules run with the employment type pinned to `Intern`; only the
   seniority/years veto or a `not_tech` verdict can remove one.
4. **Summaries.** `summaries_pending` is drained oldest-first through the provider chain
   (Mistral → Gemini → Workers AI → Groq → GitHub Models; see `src/llm`). Published records get
   their summary and any fields the rules left empty (season, graduation years, citizenship,
   sponsorship). Pending (ambiguous) records are decided by the model's `is_internship`,
   `role_family` and `confidence` (≥ 0.7 publishes or drops; below it waits). When every provider
   is exhausted the jobs stay queued and the site shows "summary pending".
5. **Retention.** Records closed more than 30 days ago leave the shards; held entries age out at
   90 days.
6. **Write outputs** under `--data`:

| Path | Contents | Deployed |
| --- | --- | --- |
| `jobs/<xx>.json` | full records keyed by id (256 buckets, sorted keys, 2-space JSON) | yes |
| `index/latest.json`, `index/7d.json`, `index/all.json` | open records with `posted_at` in the window, newest first | yes |
| `companies.json` | companies with ≥ 1 open internship: name, domain, ATSs, careers URL, open count | yes |
| `pages.json` | the SEO category pages (7 families × all/season/remote, top 25 states, top 15 companies) | yes |
| `grouped.json` | folded job id → canonical job id | yes |
| `feeds/*.xml` | Atom feeds: all, per family, per state with open jobs, remote (open records only) | yes |
| `meta.json` | run stats for `/status` (plan 2.7) | yes |
| `pending/<xx>.json` | records waiting on the LLM gate | no |
| `review/held.json`, `review/locations.json` | scam-screen holds, unparsed locations | no |

   The workflow copies the deployed paths into the site's `dist/` by `DEPLOY_MAP` in
   `src/publish/orchestrate.ts`: `feeds` → `feeds`, everything else → `data/<same name>`.
   A `review/held.json` or `grouped.json` that fails its schema is logged and replaced by an
   empty one rather than failing the run.
7. **Alerts.** The run's genuinely new records (never reposts or changes, at most 100) are posted
   to Discord and Telegram when the secrets are set. `--no-alerts` or the environment variable
   `SUPPRESS_ALERTS=true` skips this (logged as `alerts=false reason=suppressed`).

## Two state databases

Each crawl job keeps its own `state-*.sqlite` in its Actions cache (boards polled, jobs seen,
content hashes). The publish job cannot read those caches, so it keeps a third file,
`state-publish.sqlite`, with what only it needs: the gate verdict per canonical key (`jobs_seen`),
the `summaries_pending` queue and the per-provider `llm_usage` counters that enforce the daily caps.
It is restored from and saved to the Actions cache like the crawl state.

## meta.json

`boards` sums each artifact's per-ATS polled/ok/failed counts; `jobs.new` is the number of records
that became visible this run; `latency` is the median and p90 of `first_seen_at − posted_at` over
this run's new records whose posted time came from the ATS, excluding samples above 7 days (a
first crawl stamps weeks-old postings as first seen now; those are backfill, not discovery
latency, so `/status` reflects postings discovered within a week of publication; the excluded count
is logged); `llm` is today's usage per provider;
`schedule.lateness_min` is minutes past the `:17` cron target for scheduled runs, null otherwise.

## Education requirements and matching

The summarizer reads both the required (minimum) and the preferred qualifications and returns an
`education` object: accepted degree levels, named majors, an inclusive graduation-year window
(`grad_year_min`/`grad_year_max`), a minimum GPA, whether current enrollment is required, and the
upper bound of any experience range (`years_experience_max`); plus `is_new_grad` for entry-level
full-time roles. Every field is null or empty when the posting does not state it; the prompt
forbids guessing and the validator rejects any string carrying links, emails, phones or HTML.

`enrichFromSummary` stores the object on the record (`education`), fills `grad_years` from the
window, and `toIndexRow` projects four fields onto every index row (`grad_min`, `grad_max`,
`degree` = the least demanding accepted level, `enrolled`) so the explore table and the
"For you" page can hide ineligible postings without loading buckets.

`src/publish/match.ts` is the deterministic matcher: a posting is ineligible for a profile when its
graduation window excludes the profile's year, it requires a higher degree level, it requires
citizenship and the profile is not a citizen, it does not sponsor and the profile needs
sponsorship, or it requires enrollment and the profile is not enrolled. Unknown on either side
never disqualifies. Eligible postings are scored 0–100: must-have skill overlap 60, nice-to-have
15, role family 15, location/remote 10. The site carries a byte-for-byte copy in
`packages/site/src/lib/match.ts`; see `docs/matching.md`.

## Environment variables

| Variable | Used for |
| --- | --- |
| `MISTRAL_API_KEY` | primary summarizer |
| `GEMINI_API_KEY` | fallback summarizer |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_TOKEN` | Workers AI fallback |
| `GROQ_API_KEY` | fallback |
| `GITHUB_MODELS_TOKEN` | last-resort fallback |
| `DISCORD_WEBHOOK_URL` | Discord digest |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Telegram digest |
| `SITE_URL` | absolute links in feeds and alerts (also `--site-url`) |
| `GITHUB_EVENT_NAME` | set by Actions; `schedule` enables the lateness measurement |
| `SUPPRESS_ALERTS` | `true` disables Discord/Telegram posting without removing the secrets |

Missing LLM keys mean no summaries (jobs publish with "summary pending"); missing alert secrets
mean no alerts. Logs print counts, ids and codes only.

## Exit codes

0 when the run completed (even with exhausted providers or missing artifacts); 1 when the registry,
the state file or the store could not be read or written.
