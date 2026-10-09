# Workday

Workday hosts the careers sites of most of the Fortune 500 but has no public job-board API.
Every tenant site (`{tenant}.wd{N}.myworkdayjobs.com`) is driven by an undocumented JSON
endpoint that the site's own JavaScript calls. It is community-reverse-engineered and can
change without notice, which is why Workday runs in its own crawl job (plan section 4.4) with
its own fixture-drift check.

## Endpoint

List (20 postings per page, newest first):

```
POST https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
Content-Type: application/json
Accept: application/json

{"appliedFacets":{},"limit":20,"offset":0,"searchText":""}
```

Response: `{ total, jobPostings: [{ title, externalPath, locationsText, postedOn,
bulletFields[], timeType?, remoteType? }], facets, userAuthenticated }`.

- `limit` above 20 returns an empty array, not an error.
- `postedOn` is text: `Posted Today`, `Posted Yesterday`, `Posted 3 Days Ago`,
  `Posted 30+ Days Ago`, localized on non-English sites. The adapter maps it to date
  precision (`posted_at_source = WORKDAY_TEXT`); anything it cannot parse falls back to our
  first-seen time.
- `externalPath` ends in `_<requisition id>`; multi-postings of one requisition carry a `-1`,
  `-2` suffix (`..._JR2026522032-1`). The suffixed segment is the external id (unique per
  posting); `bulletFields[0]` is the bare requisition id and becomes `internalReqId`.
- `searchText` filters loosely (NVIDIA: 2,000 postings total, 1,054 for "intern"). The crawl
  sends an empty string and lets the gates decide; the full list is what closure detection
  needs.
- Fast paging silently drops pages: an empty page before `total` is reached is a throttle
  signal, not the end of the list. The adapter retries that page once after 5 s and then fails
  the fetch (so the diff engine never treats the gap as closures).

Detail (one request per new posting):

```
GET https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}{externalPath}
Accept: application/json
```

Response: `{ jobPostingInfo: { id, title, jobDescription (HTML), location,
additionalLocations[], postedOn, startDate, endDate, timeType, jobReqId, remoteType,
externalUrl, country{descriptor, alpha2Code}, ... }, hiringOrganization{name}, similarJobs }`.

- `endDate` (YYYY-MM-DD) is the application deadline.
- `startDate` is the requisition start date; it is kept on the raw job but not yet mapped.
- `remoteType` values seen live: `Onsite Job`, `Hybrid Job`, `Hybrid`, `Remote Job`.
- `externalUrl` uses the site's canonical casing (`Cisco_Careers`) even when the registry key
  is lowercase; it is used as the apply URL when it is on an allowed Workday host.

Shapes recorded 2026-10-09 from `nvidia` (wd5, NVIDIAExternalCareerSite), `boeing` (wd1,
EXTERNAL_CAREERS) and `cisco` (wd5, cisco_careers) are in
`packages/pipeline/test/fixtures/workday/`; `record.ts` there re-records them.

## Politeness policy (plan 10.2)

`WORKDAY_POLICY`: 1 concurrent request per tenant host, at least 2 s between requests, plain
`fetch` with the fixed `WalkPathBot/1.0` User-Agent, no cookies, no fingerprint spoofing, no
proxies. Allowed hosts are `*.myworkdayjobs.com` and `*.myworkdaysite.com`; redirects off
those hosts are refused by the HTTP client. Each tenant's `robots.txt` is honoured (none of
the sampled tenants disallow `/wday/cxs/`). A 403 or 429 is surfaced as an `HttpError`: the
client backs off, the diff engine records a failed fetch for the board, and three consecutive
failures flag the board `needs_refingerprint` on `/status`. Nothing retries past a block.

What a block looks like: Workday career sites sit behind Cloudflare bot management
(`__cf_bm` cookie). A challenged request returns an HTML page (status 403 or 503) on a JSON
endpoint; a rate limit returns 429 or an empty `jobPostings` array with `total > 0`. The probe
script classifies these as `blocked`, `challenge` and `empty`.

## Week-1 tolerance experiment (plan 12.3, experiment 2)

Run from a GitHub Actions job (the runner IP range is what matters) and locally for comparison:

```sh
node packages/pipeline/scripts/workday-probe.ts --tenants 20 --pages 5 --delays 1000,2000,5000
```

The script pages 20 active Workday boards from `registry/boards.csv` five pages deep at 1 s,
2 s and 5 s spacing and prints one line per request (delay, board, offset, status, outcome,
postings on page, total, elapsed ms) plus a summary per delay. It never prints bodies or
headers. It uses a raw `fetch` (not the crawl client) and does not consult `robots.txt`;
it exists to measure the hosts' tolerance for exactly the requests the adapter will make,
at ≤ 100 requests per tenant, and is run by a maintainer, never on a schedule. Decide `minDelayMs` from the smallest delay with zero `blocked`, `challenge` and
`empty` outcomes across all tenants; keep 2 s if the 1 s run shows any. If 5 s still shows
blocks from the runner, Workday employers are covered only through JSON-LD or a second ATS
and `/status` says so (plan 7.3).

## Budget

The registry has 4,072 active Workday tenants. At the default policy each tenant costs about
5 list pages × 2 s = 10 s (a 1,000-posting tenant is 50 pages, 100 s). With 20 tenants in
parallel that is roughly 34 minutes of listing per run before a single detail request, which
is why `crawl-workday` runs with `--deadline-min 30` and `--detail-cap 40`: the first run
lists what it can, inserts at most 40 new postings per tenant (each a 2 s-spaced detail
request) and resumes next hour where the deadline stopped it, so the initial backfill takes
several hours; after that an hourly run only pays for genuinely new postings. Raise the cap
once the backlog is drained and the tolerance experiment says the hosts accept it.

## What "stop on 403" means

A 403 is `HttpError('forbidden')`: the client does not retry it, the diff engine records a
failed fetch (never closures) and bumps the board's failure count, and `/status` lists the
tenant. The hourly run still polls that tenant once per hour with the same plain request;
nothing is escalated, rotated or spoofed. If the block persists for three runs the board is
flagged `needs_refingerprint` for a maintainer to disable or replace with the employer's own
careers page. That single polite request per hour is the "stop": no retries, no evasion.
