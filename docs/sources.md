# Sources beyond the ATS APIs

## SimplifyJobs community lists (`ats: simplify`)

Two curated GitHub repositories, maintained by Simplify and thousands of contributors, hold the
best-known lists of US tech internships and new-grad roles. Their machine-readable
`.github/scripts/listings.json` files back the README tables and are what the `simplify` adapter
polls (one request per list per run):

| board_key | Repository | Rows (2026-10-10) |
| --- | --- | --- |
| `summer-internships` | https://github.com/SimplifyJobs/Summer2027-Internships (formerly `Summer2026-Internships`; the old name redirects) | 17,182 total, 4,688 active and visible |
| `new-grad-positions` | https://github.com/SimplifyJobs/New-Grad-Positions | 19,687 total, 3,130 active and visible |

Each row carries `company_name`, `title`, `locations[]`, the employer's apply `url`, `date_posted`
(epoch seconds), `sponsorship` ("Other" for ~99%, else "U.S. Citizenship is Required", "Does Not
Offer Sponsorship" or "Offers Sponsorship"), `degrees[]` and a `category`; the internship list also
has `terms[]` such as "Summer 2027". There is no description: the adapter writes a short generated
paragraph naming the list and those facts, and the employer's posting stays the source of truth.

### Licence

Neither repository declares a licence (no `LICENSE` file; the GitHub API reports none; the
READMEs do not mention one). Absent a licence the repository contents are the maintainers'
copyright, but what WalkPath takes from them is a list of facts about public job postings
(employer, title, location, the employer's own URL, the day it was posted), which the lists exist
to spread. WalkPath does not reproduce any README text or descriptions, links every row back to
the employer, labels each such job "Listed via SimplifyJobs" with a link to the repository, and is
free and non-commercial. If Simplify or a maintainer asks, set the two rows in
`registry/boards.csv` to `disabled` and the listings leave the site on the next run
(`docs/opt-out.md`).

### How list rows are merged

- The publish step prefers the employer's own ATS copy: when a list row's apply URL (after stripping
  Simplify's `utm_source`/`ref` parameters) matches an open record from any ATS adapter, the list
  row is skipped and counted as `deduped_listing` in the publish summary. ATS rows published in the
  same run win too.
- Rows the ATS crawl does not cover (bespoke career sites, Oracle HCM, iCIMS, Tesla, TikTok,
  Microsoft, Apple…) are published from the list with the per-row company name. Their company slug
  is derived from that name and has no domain, so there is no logo and no company-domain link.
- Apply URLs from the lists may sit on any https host (they are human-curated); `simplify.jobs/p/…`
  redirect links are accepted as-is and open through Simplify's redirect.
- Rows that are `active: false` or `is_visible: false` are not listed; a row that disappears from
  the list closes like any other job.
- Attribution on job pages: `source.ats === 'simplify'` renders as "SimplifyJobs list" in the site's
  `ATS_LABELS`.

### Registry rows

`registry/seed/simplify.csv` holds the two rows (`company_slug` `simplifyjobs`, no domain,
`careers_url` the repository). They are merged into `registry/boards.csv` by the maintainer.
