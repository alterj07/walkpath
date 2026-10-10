# Deploy

The site is static files on Cloudflare Pages (Direct Upload: no card, unlimited bandwidth, no
build minutes consumed because the hourly workflow builds and uploads). The published data lives
on the `data` branch of this repository. Nothing of ours runs on a server.

## How an hourly deploy works

1. `crawl-api` (and `crawl-workday` when enabled) upload their diff artifacts.
2. The `publish` job in `.github/workflows/crawl.yml` checks out `data/` from the `data` branch,
   downloads the artifacts, restores `state/state-publish.sqlite` from the Actions cache, and runs
   `packages/pipeline/scripts/publish.ts`, which writes shards, indexes, feeds and `meta.json`
   into `data/` (see `docs/publish.md`).
3. The job commits `data/` back to the `data` branch as `github-actions[bot]`
   (`chore(data): hourly publish <run id>`), or prints "nothing to commit".
4. `packages/pipeline/scripts/stage-site-data.ts --clean` deletes the committed development
   samples from `packages/site/public/{data,feeds}` and copies the published files in, following
   `DEPLOY_MAP`: `feeds/` is served at `/feeds/*`, everything else under `/data/*`.
5. `npm run build --workspace @walkpath/site` renders the Astro site (category pages are built
   from `pages.json` and `index/all.json`) and `scripts/csp-headers.ts` writes the CSP hashes and
   the sitemap line into `dist/`.
6. When `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set, `wrangler pages deploy` uploads
   `packages/site/dist` to the Pages project (`CLOUDFLARE_PAGES_PROJECT`, default `walkpath`) on
   the `main` branch, which is the production deployment. Without them the job still publishes the
   data branch and builds the site, and prints a notice.
7. On success, the Better Stack heartbeat URL is pinged when set; a missed ping for 90 minutes
   raises the alert from plan 7.3.

`meta.json` is also uploaded as a 7-day artifact named `meta` so cron drift can be measured over
the first week (plan 12.3 #6).

## Preview (staging)

`.github/workflows/preview.yml` runs on every push to `main` that touches `packages/site/`. It
builds the site with the committed sample data and, when the Cloudflare secrets exist, deploys it
to the same Pages project on the `preview` branch. Pages serves that at
`https://preview.<project>.pages.dev`, so a layout change can be checked before the next hourly run
replaces production. Without secrets the workflow only proves the build.

## One-time setup

1. **Create the `data` branch** (the publish job warns and skips the commit until it exists):

   ```sh
   git switch --orphan data
   git commit --allow-empty -m "chore(data): initialise"
   git push origin data
   git switch main
   ```

   Add a branch ruleset for `data` that allows the Actions bot to push and force-push (the monthly
   squash workflow rewrites it); see `docs/github-settings.md`.

2. **Create the Pages project** (free plan, no card). Either in the dashboard (Workers & Pages →
   Create → Pages → Upload assets → name `walkpath`) or from a machine with the token:

   ```sh
   npx wrangler pages project create walkpath --production-branch main
   ```

3. **Create the API token**: Cloudflare dashboard → My Profile → API Tokens → Create Token →
   "Edit Cloudflare Workers" template is too broad; use a custom token with the single permission
   *Account → Cloudflare Pages → Edit* on this account only. Copy the Account ID from the
   Workers & Pages overview.

4. **Set repository secrets and variables** (Settings → Secrets and variables → Actions). The
   table in `docs/operations.md` lists every name; `docs/github-settings.md` says where each value
   comes from. Only `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are needed for the site to
   go live; the LLM keys and alert tokens can be added later and are picked up on the next run.

5. **Set `SITE_URL`** to the real origin once known (`https://walkpath.pages.dev` or the custom
   domain). It feeds Astro's `site` (absolute feed URLs, sitemap, canonical links) and the
   `Sitemap:` line in `robots.txt`.

6. **Run the workflow once by hand** (Actions → crawl → Run workflow, mode `normal`) and check the
   `/status` page.

## Hosting alternative: Workers static assets

The same `dist/` deploys to a Worker with static assets (`wrangler deploy` with an `assets`
block). `_headers` and `_redirects` are honoured there too; keep
`not_found_handling = "404-page"` rather than SPA mode so unknown paths still 404 while
`/job/*` and `/company/*` resolve through `_redirects` (see `packages/site/README.md`). Pages is
the default because its Direct Upload path needs no Worker code at all.

## Rollback

- Site: Cloudflare Pages keeps every deployment; "Rollback" in the dashboard restores the previous
  one instantly.
- Data: the `data` branch history (until the monthly squash) and the weekly `state-snapshot`
  release (see `docs/operations.md`) are the restore points.

## Hosting on Vercel instead of Cloudflare

The site is static, so Vercel's free Hobby plan serves it fine (non-commercial use only, per its
terms; the crawler never runs there). `packages/site/vercel.json` holds what `_headers` and
`_redirects` do on Cloudflare: the SPA rewrites for `/job/:id` and `/company/:slug`, the security
headers with the current CSP hashes, and a build command that runs `scripts/fetch-data.ts` before
`astro build` to pull the `data` branch into `public/`. In the Vercel project set the root directory
to `packages/site`; the Node version comes from that package's `engines` field (24.x).

- Public repository: no credentials are needed; the build downloads the branch tarball.
- Each hourly run pushes the `data` branch. Create a Deploy Hook (Project → Settings → Git →
  Deploy Hooks, branch `main`) and store its URL as the `VERCEL_DEPLOY_HOOK_URL` secret so the
  publish job triggers a rebuild; without it the site refreshes only when `main` is pushed.
- Set `SITE_URL` in the Vercel environment (`https://walkpath.vercel.app`) so feeds, sitemap and
  canonical links are absolute.

## About the secrets

GitHub Actions secrets are not part of the repository. They are stored encrypted, shown to nobody
after being set (not even the owner), never exposed to pull requests from forks, and masked in logs.
A public repository exposes its code and its workflow files, not its secrets. Every secret here is
optional: with none set, the hourly run still crawls, publishes the `data` branch and builds the
site; keys only add summaries, alerts, the heartbeat and the deploy trigger. Each key is scoped to
the one thing it does (see `docs/github-settings.md`) and can be revoked at its provider.
