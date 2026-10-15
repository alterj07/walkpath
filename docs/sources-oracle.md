# Source: Oracle Cloud HCM career sites

Oracle Recruiting Cloud ("Candidate Experience") hosts the career sites of many large employers
(JPMorgan, Honeywell, Navy Federal, Oracle itself, Vertiv, Fanatics, Blue Cross Blue Shield plans,
3M-style industrials, universities and hospital systems). The registry seed of 2026-10-09 found 970
such sites among the open-source internship lists; EarlyCareerRadar's volume comes largely from
them. The adapter is `packages/pipeline/src/adapters/oracle.ts`, ATS value `oracle`.

## Endpoints (verified live 2026-10-10)

Every site is a single-page app over the same REST resources, which answer without credentials.

| Call | URL |
| --- | --- |
| List (25 per page) | `GET https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations,flexFieldsFacet.values&finder=findReqs;siteNumber={site},limit=25,offset={n},sortBy=POSTING_DATES_DESC` |
| Detail | `GET https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id={Id},siteNumber={site}` |
| Public job page / apply | `https://{host}/hcmUI/CandidateExperience/en/sites/{site}/job/{Id}` |

The detail finder is `ById;Id=`. The older `ByRequisitionId;requisitionId=` form that community
write-ups quote returns HTTP 400 "finder ... is not valid" on current tenants.

Real field names seen on three tenants (eeho.fa.us2 / CX_45001, egug.fa.us2 / CX_1, hdhe.fa.em3 / CX):

- List: `items[0].TotalJobsCount`, `items[0].requisitionList[]` with `Id`, `Title`, `PostedDate`
  (`YYYY-MM-DD`), `PostingEndDate`, `PrimaryLocation` ("Seattle, WA, United States"),
  `PrimaryLocationCountry` ("US"), `WorkplaceType` ("Hybrid", "On-site", "Remote" or ""),
  `WorkplaceTypeCode`, `JobFamily`, `JobFunction`, `WorkerType`, `ContractType`, `JobType`,
  `StudyLevel`, `ShortDescriptionStr`, `ExternalQualificationsStr`, `ExternalResponsibilitiesStr`,
  `secondaryLocations[].{Name, CountryCode}`. On the list most of the type fields are null.
- Detail: `items[0]` with `ExternalDescriptionStr`, `ExternalQualificationsStr`,
  `ExternalResponsibilitiesStr`, `CorporateDescriptionStr`, `ExternalPostedStartDate`
  (`2026-10-10T00:03:07+00:00`), `ExternalPostedEndDate`, `WorkplaceType`, `ContractType`
  ("Regular"), `WorkerType`, `JobType`, `StudyLevel`, `secondaryLocations`, `skills`,
  `requisitionFlexFields`. No `ApplyUrl` was present on the tenants sampled; the adapter builds the
  public job page URL and uses `ApplyUrl` only when it is https on an `oraclecloud.com` host.

## Mapping

- Board key `{host}/{siteNumber}` (for example `eeho.fa.us2.oraclecloud.com/CX_45001`); the
  fingerprinter derives it from `.../hcmUI/CandidateExperience/{locale}/sites/{site}[/job/{id}]`.
- `posted_at` = detail `ExternalPostedStartDate`, else list `PostedDate` at 00:00 UTC
  (`ATS_FIELD`); `application_deadline` from `ExternalPostedEndDate` / `PostingEndDate`.
- Description = `ExternalDescriptionStr` + `<h3>Responsibilities</h3>` + `<h3>Qualifications</h3>`
  sections, so the LLM sees requirements and preferred qualifications in one text.
- Employment type = first non-empty of `WorkerType`, `JobType`, `ContractType`; the internship and
  new-grad gates rely mainly on the title because these are usually null or "Regular".
- Locations = primary + secondary names, deduplicated; `remoteFlag` from `WorkplaceType`.

## Politeness and budget

One concurrent request per host and at least 1 s between requests (`ORACLE_POLICY`), the fixed
WalkPathBot User-Agent, no evasion. A 403 or 429 is handled by the HTTP client (backoff, circuit
breaker) and reaches the diff engine as a failed fetch, never as closures. An empty page before
`TotalJobsCount` is retried once after 5 s and then treated as a failed fetch; the hard cap is 200
pages (5,000 requisitions) per site. Large tenants (Oracle: 2,336 requisitions) cost ~94 list
requests plus one detail request per new posting, so give the Oracle crawl job the same deadline
and detail cap as Workday.

## Seeding the registry

`node packages/pipeline/scripts/seed-oracle.ts` collects every Oracle site URL in the SimplifyJobs
internship and new-grad lists plus kalil0321/ats-scrapers' `ats-companies/oracle.csv`, probes each
host/site once with a `limit=1` list request (1 request per host, 1 s gaps, 8 hosts in parallel), and
writes `registry/seed/oracle.csv` with the same header as `boards.csv`. A maintainer reviews the
file and merges the rows into `registry/boards.csv` by pull request; the CI registry check validates
them with the same probe. Re-runs keep `added_at`, slugs and domains for rows already present.
