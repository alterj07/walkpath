# GitHub repository settings

Everything in the repository files (workflows, CODEOWNERS, Dependabot, issue templates) is
versioned. The settings below live in the GitHub UI and have to be set by hand once. Paths are
relative to `https://github.com/alterj07/walkpath`. All of them are free on a public repository.

## 1. Branch protection on `main`

Settings → Branches → Add branch ruleset (or classic rule) for `main`:

1. Require a pull request before merging; required approvals: 1; dismiss stale approvals; require
   review from Code Owners (CODEOWNERS routes everything to `@alterj07`).
2. Require status checks to pass before merging, and require branches to be up to date. Checks to
   require once they have run at least once: `check` (from `ci.yml`), `analyze
   (javascript-typescript)` (from `codeql.yml`), `review` (from `dependency-review.yml`).
   The registry live check runs inside `check` on pull requests, so it is covered by that one.
3. Block force pushes and deletions.
4. Do not allow bypass; include administrators ("Enforce for admins" / no bypass list).

## 2. The `data` branch

The hourly publish job commits JSON shards to a `data` branch that is never merged into `main`.

1. Create it once, empty and unrelated to `main`:

   ```sh
   git switch --orphan data
   git commit --allow-empty -m "chore(data): initialize data branch"
   git push -u origin data
   git switch main
   ```

2. Who may write to it. Two free options:
   - **Recommended: the default `GITHUB_TOKEN` with `contents: write` on the publish job only.**
     No key to create, rotate or leak; the token lives for one job; other jobs in the workflow
     keep `contents: read`. The trade-off is that `contents: write` is repository-wide for that
     job's lifetime, which is why the publish job is the only job that gets it and why it runs
     only from `main` (fork PRs never get secrets or write tokens).
   - A deploy key with write access. GitHub cannot limit a deploy key to one branch, so it is not
     safer than the scoped token and adds a secret to manage. Not recommended.
3. Add a ruleset for `data` that blocks force pushes and deletions and allows pushes only from the
   GitHub Actions app (Settings → Branches → New ruleset → target `data` → Bypass list: "GitHub
   Actions" app with "Always allow"; restrict updates so no human pushes land there by accident).
   The publish job commits normally (no force push); the monthly squash workflow is the only
   force-push and must be allowed for the Actions app.

## 3. Actions settings

Settings → Actions → General:

1. Actions permissions: "Allow alterj07, and select non-alterj07, actions and reusable workflows";
   allow actions created by GitHub; in the allow list enter
   `actions/*, github/*, ossf/*, cloudflare/*`.
2. Workflow permissions: "Read repository contents and packages permissions" (read-only default;
   jobs that need more declare it in their `permissions:` block).
3. Untick "Allow GitHub Actions to create and approve pull requests".
4. Fork pull request workflows: "Require approval for all outside collaborators" (or "all external
   contributors"), so a fork PR cannot run a workflow until a maintainer looks at it.
5. Artifact and log retention: 7 days is plenty; the crawl artifacts already set `retention-days: 1`.

## 4. Code security

Settings → Code security (free for public repositories):

1. Dependabot alerts: on. Dependabot security updates: on (the version-update schedule is in
   `.github/dependabot.yml`).
2. Secret scanning: on. Push protection: on.
3. Code scanning: CodeQL runs from `.github/workflows/codeql.yml` (not the default setup; do not
   enable both). Keep "Protection rules" default so high-severity alerts block merges via the
   required check.
4. Private vulnerability reporting: on (the link in `SECURITY.md` depends on it).

## 5. General

Settings → General:

1. Disable Wiki and Projects (less surface, nothing to moderate).
2. Pull requests: allow squash merging only; default commit message "Pull request title and
   description" so merges keep the conventional-commit title.
3. Automatically delete head branches: on.
4. Social preview image and description: "Free US tech-internship board, updated hourly."

## 6. Variables

Settings → Secrets and variables → Actions → Variables:

| Variable | Value | Used by |
| --- | --- | --- |
| `WORKDAY_ENABLED` | `false` until the week-1 tolerance experiment passes, then `true` | `crawl.yml` (gates the `crawl-workday` job) |
| `SITE_URL` | `https://<project>.pages.dev` (or the custom domain, no trailing slash) | site build: absolute feed URLs, sitemap, canonical links |
| `SUPPRESS_ALERTS` | unset normally; `true` for one hour after restoring state from a snapshot | `crawl.yml` publish job (maps to `--no-alerts`) |
| `CLOUDFLARE_PAGES_PROJECT` | Pages project name; defaults to `walkpath` when unset | `crawl.yml` and `preview.yml` deploy steps |

## 7. Secrets

Settings → Secrets and variables → Actions → Secrets. Every one is optional: a missing secret
disables that feature (the adapter is skipped, the provider is left out of the chain, the alert is
not sent). Create each with the smallest scope the vendor offers.

| Secret | Where to get it (free, no card) | Minimal scope |
| --- | --- | --- |
| `MISTRAL_API_KEY` | console.mistral.ai → API keys, on the Experiment plan (phone verification) | One key, one workspace; prompts may be used for training, which is why only public posting text is sent |
| `GEMINI_API_KEY` | aistudio.google.com → Get API key, free tier | A key in a dedicated Google Cloud project with nothing else in it |
| `CLOUDFLARE_ACCOUNT_ID` | dash.cloudflare.com → Workers & Pages → account ID in the sidebar | Not secret-sensitive, stored as a secret to keep it out of logs |
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com → My Profile → API Tokens → Create Token → Custom | Permission **Cloudflare Pages: Edit** on **one account** only (plus **Workers Scripts: Edit** if the site is deployed as Workers static assets); no zone permissions |
| `CLOUDFLARE_AI_TOKEN` | Same page, separate token | **Workers AI: Read** on one account (Workers AI inference needs only read) |
| `GROQ_API_KEY` | console.groq.com → API Keys | One key; free tier |
| `GITHUB_MODELS_TOKEN` | github.com → Settings → Developer settings → Fine-grained tokens | Only the `models:read` account permission; no repository access; 90-day expiry |
| `DISCORD_WEBHOOK_URL` | Discord server → channel settings → Integrations → Webhooks → New Webhook | One webhook bound to one channel; it can only post there |
| `TELEGRAM_BOT_TOKEN` | Telegram @BotFather → /newbot | Add the bot as an admin of the broadcast channel with "Post messages" only |
| `TELEGRAM_CHAT_ID` | The channel's `@username` or numeric id (send a message and read `getUpdates`) | Not sensitive; stored as a secret to keep it out of logs |
| `SMARTRECRUITERS_API_KEY` | developers.smartrecruiters.com → register a free developer account → create an app → API key | Read-only Posting API; without it the SmartRecruiters adapter is skipped (plan 10.2) |
| `SENTRY_DSN` | sentry.io → Developer plan → create a Node project → Client Keys (DSN) | A DSN can only submit events; put the crawl and the site in separate projects if you want separate quotas |
| `BETTERSTACK_HEARTBEAT_URL` | betterstack.com → Uptime → Heartbeats → create one with a 60-minute period and 30-minute grace | The URL only accepts pings; it alerts when a run is more than 90 minutes late |

After adding or rotating a secret, run the workflow once by hand (Actions → crawl → Run workflow)
and confirm the run log prints only counts and ids.

## 8. Cloudflare project

1. Workers & Pages → Create → Pages → "Direct Upload" (not Git integration: the hourly deploy comes
   from the workflow with `wrangler pages deploy`, and Direct Upload does not count against the
   500 CI builds per month).
2. Project name becomes the `<project>.pages.dev` hostname; put it in `SITE_URL`.
3. Web Analytics → add a site for that hostname → copy the beacon token into the site layout
   (the CSP already allows `static.cloudflareinsights.com`).
4. If a custom domain is added later: DNSSEC on, bind the domain to the project before pointing
   DNS at it, and update `SITE_URL`.
