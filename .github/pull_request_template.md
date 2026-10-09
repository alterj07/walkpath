## What

<!-- One or two sentences. The PR title must be a conventional commit: `type(scope): lowercase summary`. -->

## Checklist

- [ ] Title follows `type(scope): lowercase summary` (feat, fix, docs, test, chore, ci, refactor)
- [ ] `npm run check` passes locally (typecheck, lint, tests)
- [ ] No new dependency, CDN or third-party script; if one was added, the reason is written below
- [ ] Registry rows (if any) were validated with `node packages/pipeline/scripts/validate-registry.ts --base origin/main`
- [ ] Logs and error messages print counts and ids only: no response bodies, headers, secrets or job text
- [ ] Strings from outside the repo (ATS JSON, LLM output, URL params, localStorage, imports) are parsed through a schema at the boundary

## Dependency reason (only if a dependency was added)

<!-- Why the platform (fetch, URL, crypto.subtle, node:sqlite) was not enough. -->
