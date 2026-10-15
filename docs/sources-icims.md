# Source: iCIMS

iCIMS hosts the careers portal of a large share of mid-size and enterprise US employers
(General Dynamics, Peraton, Uber's university program, Shure, Canon, Schwab …). The registry seed
found 743 iCIMS portals among the companies we already track, so it is the single biggest source
left after the five API-backed ATSs and Workday.

## What is public, and what we use

iCIMS has **no public JSON job-board API**. Two zero-auth HTML pages carry everything we need
(verified 2026-10-10 against `careers-gdms`, `careers-sig` and `careers-peraton`):

| Request | What it returns |
| --- | --- |
| `GET https://{label}.icims.com/jobs/search?pr={page}&mobile=true&needsRedirect=false` | The job list: 20–50 cards per page. Each card has the job URL with the numeric id, the title (`<h3>` and the anchor's `title="{id} - {title}"`), the posted date as a tooltip (`<span title="10/9/2026 2:00 PM">`), a teaser paragraph, and a label/value list (ID, Job Location, Category, Required Clearance, salary range …). |
| `GET https://{label}.icims.com/jobs/{id}/job?in_iframe=1` | The job page, which embeds a schema.org `JobPosting` JSON-LD block: `description` (full HTML), `datePosted` (ISO), `validThrough`, `employmentType`, `jobLocation[].address`, `hiringOrganization.name`. |

`{label}` is the portal subdomain, which is **not** always `careers-{company}`: live examples include
`careersus-shure`, `university-uber`, `career-schwab`, `external-canoncareers`, `uscareers-lennox`.
The board key is therefore the whole label.

### Why the mobile search page

The `in_iframe=1` search page returns the **same first page for every `pr=`** unless the session
cookie from the first response is replayed (measured: `pr=0` and `pr=1` both returned ids
72997/73475/75513). The `mobile=true&needsRedirect=false` variant pages correctly with no state:
`pr=0` → 20 ids, `pr=1` → a disjoint 20 ids (0 overlap). Older portals render the list as
`<tr class="iCIMS_JobListingRow">` instead of `<li class="iCIMS_JobCardItem">`; the parser accepts both.

There is no total-count field, so paging stops when a page adds no new id (iCIMS repeats the last
page past the end rather than returning an empty one), capped at `ICIMS_MAX_PAGES = 100`.

### Timestamps

The card tooltip is portal-local wall-clock with no zone (`10/9/2026 2:00 PM`), so it is read as UTC
and is effectively date precision; `posted_at_source` is `ATS_FIELD`. Once the job page is fetched,
the JSON-LD `datePosted` replaces it. No date at all → `first_seen_at` / `FIRST_SEEN`.

### Fields we do not get

`employmentType` in the JSON-LD is `OTHER` on every portal sampled, so it is dropped and the
internship and new-grad gates rely on the title. Multi-location requisitions list one location per
card; the JSON-LD may carry several.

## Politeness and robots

`ICIMS_POLICY` is one concurrent request per portal, 2 s apart, `*.icims.com` only. Each portal's
robots.txt is honoured by the crawl client. Most portals allow `/jobs/search` and disallow only
`/jobs/*login`, `/connect/*resume` and similar; **some disallow everything** (`careers-sig` is
`User-agent: * / Disallow: /`). The seed marks those boards `disabled` so they are never polled and
the coverage gap is visible rather than silent. Detail pages are fetched only for new keys, so a
400-job portal costs about 10 list requests per hour.

## Seeding

```sh
node packages/pipeline/scripts/seed-icims.ts --limit 300 --concurrency 8
```

Candidates come from the two SimplifyJobs lists (every `*.icims.com` apply URL; 327 distinct portals
on 2026-10-10) plus the kalil0321/ats-scrapers inventory when it is reachable. Each label is probed
once with the mobile search page: cards present → `active`, a search page with no cards → dropped,
anything else → `needs_refingerprint`.

Run of 2026-10-15, 300 candidates: **296 rows written** — 270 `active`, 15 `disabled` (robots
disallow all), 11 `needs_refingerprint`, 4 dropped. Output: `registry/seed/icims.csv` (same header as
`registry/boards.csv`). A maintainer merges those rows into `registry/boards.csv` by pull request,
as plan section 11.4 requires.

## Attribution and opt-out

Listings link to the employer's own iCIMS job page (`/jobs/{id}/job`); WalkPath never proxies the
application. The standard opt-out in `docs/opt-out.md` applies: blocking `WalkPathBot` in a portal's
robots.txt, or asking us to disable the board, removes it within a day.
