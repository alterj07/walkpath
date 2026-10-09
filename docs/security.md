# Security

WalkPath holds no accounts, passwords, resumes or email addresses. The worst case is a student
being harmed through the site, or the pipeline being hijacked through the public repository.

## Threat model

| Who could be harmed | How | Where it enters |
| --- | --- | --- |
| Student reading a job page | Script or HTML in an employer's description (stored XSS) | ATS description HTML, company blurbs, LLM summary text |
| Student clicking Apply | Phishing or scam destination; look-alike domain | Apply URL from the ATS, a malicious registry entry, a hijacked board |
| Student following an alert | Same, plus impostor "recruiters" DMing in Discord | Public community channels |
| Everyone | Pipeline compromise exfiltrating secrets or publishing a poisoned site | GitHub Actions, npm, the data branch |
| Everyone | Prompt injection making the summarizer insert a link, phone number or false claim | Job text sent to the LLM |
| Visitor's own data | Crafted import file injecting HTML into saved notes | Browser storage, import feature |
| The project | Crawler used as a nuisance; subdomain takeover; impersonation | Operations |

## Controls

### Content: nothing from a job posting is trusted

- Sanitize at publish time in the Actions job with an allowlist (`sanitize-html`): `p, br, ul, ol,
  li, strong, em, b, i, h3, h4, table, thead, tbody, tr, th, td`; no `a`, `img`, `iframe`, `svg`,
  `style`, `script`, `form`, `input`, event or style attributes. Links in descriptions become plain
  text. Only the sanitized HTML is stored.
- Sanitize again in the browser (DOMPurify, same allowlist) before injecting.
- `dangerouslySetInnerHTML` is used exactly once, for the sanitized description; the
  `react/no-danger` lint rule flags every other use. All other fields render as text nodes.
- LLM output is data, not markup: validated against a JSON schema; any string containing `<`,
  `http`, `www.`, `@` or a phone-number pattern is rejected; list and string lengths are capped.
- Feeds and alert messages escape every field; Discord embeds link only to our job page.

### Links: the Apply button is the whole attack surface

- `https://` only; `javascript:`, `data:`, `mailto:`, `tel:`, IP-literal hosts, userinfo and URL
  shorteners are rejected (`packages/pipeline/src/links.ts`).
- Each adapter declares the legitimate hosts for its ATS; an apply URL on any other host and not on
  the company's registry domain is downgraded to "Apply on the company's careers page" and flagged.
- Tracking parameters are stripped. Links carry `rel="noopener noreferrer nofollow"`.
- A scam-signal screen holds a job for review when the text matches fee, wire, gift card, crypto,
  "WhatsApp to apply", SSN or "earn $N/day from home" patterns, or the company has no registry entry.
- "Report this listing" on every job page opens a pre-filled GitHub issue.

### Registry integrity

`registry/boards.csv` changes only through reviewed pull requests; CI confirms a new board resolves
on a known ATS host. Logos are fetched for the registry domain so a mismatch is visible.

### Pipeline and supply chain

- The scheduled workflow runs only from `main`. Fork PRs get no secrets; `pull_request_target` is
  never used. Permissions are minimal (`contents: write` only on the publish job).
- Actions are pinned by commit SHA; npm uses a committed lockfile with `npm ci` and
  `ignore-scripts=true`; Dependabot, secret scanning with push protection and CodeQL are enabled.
- Tokens are scoped: Cloudflare token to one project, Discord webhook and Telegram bot to one
  channel, LLM keys per provider. Logs print counts and ids, never bodies or headers.
- The crawler uses a fixed User-Agent with a contact URL, per-host concurrency caps, backoff,
  robots.txt, 15 s timeouts, 5 MB body caps, and does not follow redirects off the expected host.

### Browser

Content Security Policy and the other headers live in `packages/site/public/_headers`:
`default-src 'self'`, scripts only from our origin and the Cloudflare analytics beacon, images from
our origin and `cdn.brandfetch.io`, `frame-ancestors 'none'`, `base-uri 'none'`,
`form-action 'none'`, HSTS, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
`X-Frame-Options: DENY`. No cookies, no third-party embeds. `localStorage` import is validated
against a schema (ids `^[a-f0-9]{12}$`, stage enum, notes ≤ 500 chars).

### Operations

`registry/sources.json` is the kill switch for a source or for publishing. The previous Release
snapshot and the previous Cloudflare deployment are the rollback points.

## Pre-launch checklist

See `docs/launch-checklist.md`.
