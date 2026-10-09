# Security policy

WalkPath holds no accounts, passwords, resumes or email addresses. The things worth protecting are
visitors (a scam posting, a poisoned apply link, script in a job description) and the publish
pipeline (secrets in GitHub Actions).

## Reporting

Open a private security advisory on this repository
(https://github.com/alterj07/walkpath/security/advisories/new). Please do not open a public issue
for a vulnerability. You will get a reply within 7 days.

## Controls

The threat model and the controls that address it live in `docs/security.md`. In short: every string
from outside (ATS JSON, LLM output, URL parameters, localStorage, imported files) is parsed through
a schema at the boundary; job descriptions are sanitized twice (publish time and render time); apply
links are validated against a per-ATS host allowlist; the scheduled workflow runs only from `main`
with minimal permissions and SHA-pinned actions.

## Kill switch

`registry/sources.json` disables a single source or the whole publish step on the next hourly run.
