# Operator setup

Everything in this repository is versioned, but a handful of one-time steps live in the GitHub and
Cloudflare dashboards and need a human: the `data` branch, repository settings, the Pages project,
and the secrets and variables the hourly workflow reads. The interactive wizard walks through them
in order, opens each page, verifies what it can, and never writes a secret to disk.

```sh
bash scripts/setup-wizard.sh
```

- Re-runnable: it skips the `data` branch when it already exists, offers existing non-secret values
  as defaults, and (with the GitHub CLI) skips secrets that are already set.
- With `gh` installed and logged in, secrets and variables are set directly; without it, the wizard
  opens the right Settings page and waits while you paste.
- Secrets are read with hidden input, checked for shape, verified against the vendor API where that
  is possible (Cloudflare, Mistral, Gemini, Groq, GitHub Models, Discord, Telegram), then handed to
  `gh secret set` or to you, and dropped from memory. Only non-secret values (`SITE_URL`,
  `WORKDAY_ENABLED`, `CLOUDFLARE_PAGES_PROJECT`, `PUBLIC_BRANDFETCH_CLIENT_ID`) are kept in the
  git-ignored `.env` so re-runs can offer them as defaults.

The 13 stages, in order:

| # | Stage | Produces |
| --- | --- | --- |
| 1 | Preflight: git, node, curl, optional `gh` | nothing |
| 2 | Create the empty `data` branch | the branch on origin |
| 3 | GitHub Actions permissions | settings |
| 4 | Code security and general settings | settings |
| 5 | Branch rulesets for `main` and `data` | settings |
| 6 | Cloudflare account, Pages project, account id | `CLOUDFLARE_PAGES_PROJECT`, secret `CLOUDFLARE_ACCOUNT_ID` |
| 7 | Cloudflare deploy token and Workers AI token | secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_AI_TOKEN` |
| 8 | Repository variables | `SITE_URL`, `WORKDAY_ENABLED`, `PUBLIC_BRANDFETCH_CLIENT_ID`, `CLOUDFLARE_PAGES_PROJECT` |
| 9 | LLM provider keys | `MISTRAL_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `GITHUB_MODELS_TOKEN` |
| 10 | SmartRecruiters key and alert channels | `SMARTRECRUITERS_API_KEY`, `DISCORD_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| 11 | Heartbeat and error reporting | `BETTERSTACK_HEARTBEAT_URL`, `SENTRY_DSN` |
| 12 | First run and what to check | nothing |
| 13 | Week-1 experiments reminder | nothing |

Every secret is optional: a missing one disables that feature (the adapter is skipped, the provider
leaves the chain, the alert is not sent). The exact scope for each is in `docs/github-settings.md`;
how the hourly run uses them is in `docs/operations.md` and `docs/publish.md`.
