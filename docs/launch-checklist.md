# Launch checklist

Three lists: the pre-launch security checklist (plan section 11.10), the launch gate (plan 9.3),
and the week-1 experiments (plan 12.3). Nothing ships until every box in the first two is ticked.

## Pre-launch security checklist (plan 11.10)

- [ ] Two-pass sanitization live; `react/no-danger` lint passing with the single exception documented
- [ ] Apply-URL validator with per-ATS host allowlist, shortener blocklist, tracking-param stripping; off-host links downgraded to the careers page
- [ ] Scam-signal screen and "report this listing" wired to GitHub issues; held jobs visible on `/status`
- [ ] LLM output schema validator rejects URLs, emails, phone patterns, HTML; prompt-injection fixtures pass
- [ ] Branch protection on `main`; registry changes by reviewed PR only; CI fingerprint check
- [ ] Actions: SHA-pinned actions, minimal permissions, no `pull_request_target`, lockfile + `npm ci`, `ignore-scripts`, Dependabot, secret scanning with push protection, CodeQL, Scorecard
- [ ] Secrets scoped and rotated; run logs print no bodies or headers; deploy key limited to the data branch (or the scoped `GITHUB_TOKEN` alternative in `docs/github-settings.md`)
- [ ] CSP and security headers verified with Mozilla Observatory (A grade); no third-party JS besides the analytics beacon
- [ ] localStorage import validated by schema; "clear my data" works
- [ ] Discord AutoMod and verification set; Telegram channel read-only; safety line on every alert
- [ ] `SECURITY.md`, privacy page naming Mistral, Google, Cloudflare, Brandfetch; kill switch and rollback tested
- [ ] ZAP baseline scan clean; manual walkthrough of the threat model (`docs/security.md`) signed off

## Launch gate (plan 9.3)

| Gate | Target | Measured | Date | Pass |
| --- | --- | --- | --- | --- |
| Open US tech internships on the board | ≥ 3,000 (confirm the number in week 1; peak season is Aug–Oct) | | | [ ] |
| Median discovery latency on API-backed boards (`first_seen_at − posted_at`, from `/status`) | < 40 min | | | [ ] |
| Dead apply links in a 200-link random sample | < 1% | | | [ ] |
| Consecutive days of hourly runs without a missed hour | 3 | | | [ ] |
| Money spent | $0 | | | [ ] |

## Week-1 experiments (plan 12.3)

| # | Experiment | Effort | What it decides | Status | Result |
| --- | --- | --- | --- | --- | --- |
| 1 | Volume census: seed 2,000 boards, run the Greenhouse/Lever/Ashby adapters once with both rule gates, count open tech internships and, after 48 h of hourly runs, new ones per day | half a day | LLM volume and the launch-gate number | not started | |
| 2 | Workday tolerance: page the cxs endpoint on 20 tenants from a GitHub Actions job at 1, 2 and 5 s (`packages/pipeline/scripts/workday-probe.ts`); log the first 403, challenge or empty page | half a day | the default Workday delay and whether `WORKDAY_ENABLED` can be `true` | not started | |
| 3 | Header probe: `curl -I` the five ATS list endpoints for 20 boards each; record ETag, Last-Modified, Cache-Control; re-request with If-None-Match | 1 hour | whether conditional GET is worth wiring into `boards_state` | partly done (Greenhouse and Lever send ETags; Ashby, Workable, SmartRecruiters unchecked) | |
| 4 | Timestamp audit: for 200 Greenhouse and 200 Lever jobs, compare `first_published` / `createdAt` to the date on the hosted page | 2 hours | whether those fields mean "published" | not started | |
| 5 | LLM quota smoke test: 300 real postings through the Mistral → Gemini → Workers AI chain with the JSON schema; measure parse-failure rate, latency, quota per provider; confirm no card prompts | 2 hours | provider order and caps | not started (needs the keys in `docs/github-settings.md`) | |
| 6 | Cron reliability: log every scheduled start time to `meta.json` (`schedule.lateness_min`); compute the lateness distribution | passive, 1 week | whether an external pinger is needed before launch | not started | |
| 7 | Hosting check: deploy the empty Astro site with wrangler to both Workers static assets and Pages; confirm no card prompt, the SPA fallback for `/job/<id>`, and that hourly deploys are not counted as builds | 1 hour | Pages vs Workers static assets | not started | |
