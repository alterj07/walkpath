# @walkpath/site

Astro static site with one React island (the explore table). It reads the JSON files the pipeline
publishes (`/data/index/*.json`, `/data/jobs/<xx>.json`, `/data/companies.json`, `/data/meta.json`,
`/feeds/*.xml`) from its own origin at runtime; nothing is fetched from anywhere else except
company logos (Brandfetch CDN, optional) and the Cloudflare analytics beacon.

## Develop

```sh
npm run dev --workspace @walkpath/site      # http://localhost:4321
npm run build --workspace @walkpath/site    # dist/
```

`public/data/` holds **dev sample data** (fake companies, dated 2026-10-09) so the site renders
without the pipeline. The hourly workflow overwrites `/data` with real files at deploy; nothing in
`public/data` ever reaches production. Regenerate the samples with
`node packages/site/scripts/sample-data.ts`. Widen the window to 30 days if the samples have aged out
of the default 24-hour view.

## Environment

| Variable | Purpose |
| --- | --- |
| `PUBLIC_BRANDFETCH_CLIENT_ID` | Brandfetch Logo Link client id. Unset → letter avatars. |
| `SITE_URL` | Canonical origin (`https://…`, no trailing slash). Sets Astro's `site` (absolute feed URLs on /alerts, sitemap) and, in the post-build step, appends `Sitemap: $SITE_URL/sitemap.xml` to `dist/robots.txt`. Unset → `https://walkpath.pages.dev` placeholder for `site`, and robots.txt has no Sitemap line. |

## Rules

- No inline scripts or styles of ours: `public/_headers` sets a CSP of `script-src 'self'` and
  `style-src 'self'`. CSS lives in `src/styles/global.css`; client code in islands or
  `src/scripts/*.ts`. Astro's island hydration runtime is the one inline block it emits;
  `scripts/csp-headers.ts` runs after `astro build`, hashes it and appends `'sha256-…'` sources
  to the CSP in `dist/_headers`. It fails the build if any other inline script, style tag or
  `style=""` attribute shows up.
- Every string from the data files is rendered as a text node. The single allowed
  `dangerouslySetInnerHTML` lives in `src/components/Description.tsx`: the job description,
  sanitized once by the publish job and again in the browser by `src/lib/sanitize.ts` (DOMPurify
  with the same allowlist). The `react/no-danger` lint rule is disabled on that one line only.
- Every `localStorage` access goes through `src/lib/tracker.ts`, which validates what it reads.
  Imported tracker files go through the same validator (`sanitizeTracker`) before merging.

## Routing

`/job/<id>` and `/company/<slug>` are client-rendered: one static page is emitted at
`/job/index.html` and `/company/index.html`, and `public/_redirects` serves it for every path
below (Cloudflare Pages `200` rewrites). The island validates the id (`^[a-f0-9]{12}$`) or slug
(`^[a-z0-9-]{1,80}$`) from the URL before fetching anything. Job and company pages are `noindex`;
the pre-rendered category pages carry the SEO.

On Workers static assets `_redirects` is also honoured (`assets.directory` with
`not_found_handling = "404-page"`); do not use `single-page-application` mode, which would
serve the home page for every unknown path. If `_redirects` support is ever dropped, a two-line
Worker that rewrites those two prefixes is the fallback.

## Layout and libs

- `src/layouts/Base.astro` — props `title`, `description?`, `noindex?`, `current?`
  (`'explore' | 'saved' | 'alerts' | 'status' | 'about'`).
- `src/lib/data.ts` — types (`IndexRow`, `Meta`), guards (`isIndexRow`, `parseIndexFile`,
  `parseMeta`), loaders (`loadIndex`, `loadIndexFile`, `loadMeta`), helpers (`relativeTime`,
  `absoluteTime`, `windowStartMs`, `indexFileFor`, `logoUrl`, `locationLabel`) and label maps.
- `src/lib/url-state.ts` — `parseFilters`, `serializeFilters`, `filtersToSearch`, `DEFAULT_FILTERS`.
- `src/lib/tracker.ts` — `getTracker`, `setStage`, `setNote`, `removeEntry`, `clearTracker`,
  `sanitizeTracker`, `getLastVisit`, `touchLastVisit`, `STAGES`.
