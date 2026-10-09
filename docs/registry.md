# The board registry

`registry/boards.csv` is the list of career boards WalkPath polls every hour. It is the project's
real asset: the crawler is a commodity, the registry is what decides which internships we see.

## Columns

| Column | Meaning |
| --- | --- |
| `company_slug` | Kebab-case company id used in URLs (`/company/<slug>`). Several boards may share one slug (a company with both Workday and Greenhouse). |
| `company_name` | Display name. |
| `domain` | The company's own website host (`figma.com`), or empty when unknown. Used for logos and to allow apply links on the company's domain. Follow-up: the seed only learns a domain from Greenhouse `absolute_url`s and SmartRecruiters careers-page redirects, so about 97% of rows are empty today; the crawl will derive domains from the ATS payloads (Ashby, Lever, Workable job URLs) later. |
| `ats` | One of `greenhouse`, `lever`, `ashby`, `workable`, `smartrecruiters`, `workday`, `recruitee`, `breezy`, `pinpoint`, `teamtailor`, `personio`, `bamboohr`, `jazzhr`, `jsonld`. Adapters exist for the first six in the MVP. |
| `board_key` | What the adapter polls: Greenhouse token, Lever site (`eu:{site}` for boards served from `api.eu.lever.co`), Ashby board name, Workable subdomain, SmartRecruiters company id, Workday `tenant/site`. Lowercase for Greenhouse, Lever, Ashby and Workable; SmartRecruiters and Workday keep their case. |
| `careers_url` | The public board URL (`https://job-boards.greenhouse.io/figma`) or the company's own careers page. |
| `added_at` | ISO date the row was added. Preserved across re-seeds. |
| `status` | `active` (polled), `disabled` (maintainer switched it off; never flipped back automatically), `needs_refingerprint` (the endpoint did not answer cleanly; re-checked, not polled). |
| `wd` | Workday data-center number (`1`, `3`, `5`, `12`, `103`, `503`...): the `wdN` in `tenant.wdN.myworkdayjobs.com`. Empty for other ATSs. |

`(ats, board_key)` must be unique. The file is kept sorted by `ats` then `board_key`.

`registry/sample.csv` holds 25 boards (5 each for Greenhouse, Lever, Ashby, Workable and
SmartRecruiters, the most-cited internship posters) for local development:
`--boards registry/sample.csv`.

`registry/sources.json` is the kill switch: set `sources.<ats>.enabled` to `false` to stop polling
an ATS on the next run, or `publish.enabled` to `false` to stop publishing entirely. Sources not
listed default to enabled.

## Adding a company

1. Open an issue with the **Add a company** template (company name, careers URL, website domain).
2. A maintainer runs `fingerprintUrl` on the careers URL (or `fingerprintHtml` on the page when the
   board is embedded on the company's own domain), adds a row, and opens a pull request.
3. CI runs `validate-registry`, which parses the whole file and live-checks the changed rows.
4. The next hourly run picks the board up.

Only pull requests change the registry; the issue is a request, not a write. This blocks "add my
Greenhouse board" from a fake company: the board must answer on a known ATS host and the
`careers_url` must point at that board or at the company's own domain.

## Seeding

```sh
node packages/pipeline/scripts/seed-registry.ts [--limit N] [--only greenhouse,lever] [--revalidate] [--dry-run]
```

The seed script:

1. Downloads the SimplifyJobs and vanshb03 `Summer2026-Internships` listings and fingerprints every
   apply URL. These are the companies that post tech internships; their boards get priority in
   `sample.csv`.
2. Downloads the six per-ATS board inventories from `kalil0321/ats-scrapers` (MIT).
3. Validates every candidate with one request to the ATS public endpoint, reading only the first
   64 KB of the response. `200` with the expected JSON shape = `active`; `404` = dropped;
   anything else (`403`, `429`, `5xx`, timeouts, HTML) = `needs_refingerprint`. API hosts are
   polled with the plan's per-ATS concurrency; Workday tenants get one request every 2 s each.
   Workable is probed at `apply.workable.com/api/v1/widget/accounts/{sub}` (the documented
   `www.workable.com/api/accounts/{sub}` answers `302` for every subdomain). A Lever site that
   `404`s on `api.lever.co` is tried once on `api.eu.lever.co` and, if found, keyed `eu:{site}`.
4. Writes `boards.csv`, `sample.csv` and (if missing) `sources.json`.

Verdicts are cached in `state/registry-probe-cache.json` (git-ignored) for 7 days, so re-running is
cheap and idempotent. Existing rows keep their `added_at`, `company_slug`, `company_name`, `domain`
and `careers_url`; rows a maintainer set to `disabled` stay disabled.

Known gaps: Ashby boards whose public posting API is switched off answer `404` and are dropped
even though `jobs.ashbyhq.com/<name>` still renders; companies on iCIMS, Taleo, Oracle, Rippling,
Eightfold and bespoke career sites are counted but not added (no adapter yet); a Greenhouse board
embedded on a company domain (`?gh_jid=`) needs the page HTML to find its token and is skipped by
the URL-only seed.

## Validation (CI)

```sh
node packages/pipeline/scripts/validate-registry.ts [--all] [--base origin/main]
```

Fails the build when any row does not match the schema, two rows name the same board, a changed
row's `careers_url` points somewhere other than its board or company domain, or a changed board does
not answer on its ATS (`404`), or is marked `active` but did not answer `200`. The diff needs git
history: the CI checkout must use `fetch-depth: 0`, otherwise the script warns and skips the live
check. `--all` probes every row (takes a few minutes; maintainer use).
