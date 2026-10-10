# WalkPath

A free, open-source board of US tech internships, co-ops and new-grad roles. WalkPath polls the public JSON endpoints of the
major applicant-tracking systems (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Workday)
once an hour from a GitHub Actions workflow, stamps every posting with the employer's publish time
and our first-seen time, summarizes new postings with a free-tier LLM, and publishes everything as a
static site. No accounts, no payments, no resume upload, no server of our own.

- Site: deployed from the hourly workflow to Cloudflare (static assets).
- Data: JSON shards on the `data` branch of this repository.
- Alerts: RSS feeds, a Discord webhook and a Telegram channel.

## Layout

| Path | What |
| --- | --- |
| `packages/pipeline` | TypeScript crawl, diff, gate, summarize and publish pipeline (runs in Actions) |
| `packages/site` | Astro static site with one React island for the explore table |
| `registry/` | `boards.csv` (which companies and boards we poll), `sources.json` (kill switches) |
| `.github/workflows` | `ci.yml` (checks), `crawl.yml` (hourly crawl + publish + deploy), `preview.yml` (staging build on push), security and ops workflows |
| `docs/` | `architecture`, `security`, `operations`, `publish`, `registry`, `workday`, `deploy`, `github-settings`, `launch-checklist`, `setup`, `opt-out` |
| `scripts/` | `setup-wizard.sh`, the interactive operator setup |

## Develop

```sh
npm ci
npm run check        # typecheck + lint + tests
```

Requires Node 24 (native TypeScript execution and `node:sqlite`).

## Setup and deploy

The hourly workflow runs as soon as the repository is public; with no secrets it crawls, writes
the `data` branch and builds the site. To put the site online and turn on summaries and alerts:

1. Run `scripts/setup-wizard.sh`: it creates the `data` branch, walks through the Cloudflare Pages
   project, the repository settings, and every secret and variable, verifying each key as you go.
   The same steps are written out in `docs/deploy.md` and `docs/github-settings.md`.
2. Run the `crawl` workflow once by hand and check `/status`.
3. Work through `docs/launch-checklist.md` before announcing it.

Operations (state cache, snapshots, dispatch modes, kill switch): `docs/operations.md`.

## Policy

WalkPath is a technology provider and job-search aggregator, not an employer or recruiter. Every
listing links to the employer's own apply page. Employers can opt out; see `docs/opt-out.md`.
The project never emails students and never asks for personal information.

## Licence

MIT. See `LICENSE`.
