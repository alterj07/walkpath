# What you need to do by hand

Everything in this file needs a human: a browser login, a payment-free signup, a click on a GitHub
button, or a decision only you can make. Nothing here is optional reading if you want the job count
up; the steps are ordered so that the earliest ones give the biggest increase.

Each step says **why it matters**, **what to do**, and **how to check it worked**.

---

## 0. Why the site shows so few jobs right now

Four separate causes, three already fixed in code and waiting on step 1.

| Cause | Effect on the count | Status |
| --- | --- | --- |
| The hourly crawl was cancelled by its own job timeout every hour, so no new data was ever published | The site has been frozen on one manual publish | Fixed in code (hard deadline + abort), waiting on step 1 |
| Greenhouse blocked us with HTTP 403 after about 70 seconds at 20 parallel requests, so 5,256 of 5,585 Greenhouse boards failed in that run | Lost most startup and mid-size listings | Fixed in code (4 parallel, 250 ms apart, circuit breaker) |
| Workday was switched off, and Lever's one-request-per-second limit could not cover its boards in an hour | Lost most large-employer listings | Fixed in code (Workday on by default, Lever runs as its own job over two hours) |
| Only internships were ever collected | Half of what the comparison sites list was out of scope | Fixed in code (new-grad and entry-level roles added) |

The one manual thing standing in front of all of it is step 1.

---

## 1. Merge the waiting work (do this first)

**Why it matters.** Every fix above, plus accounts, the resume matcher and the new sources, sits on
a branch. The hourly workflow always runs the copy of the code on `main`, so until this is merged
the site keeps publishing nothing. You also turned on a rule that blocks direct pushes to `main`,
which is good practice and the reason this needs you.

**What to do.** Open this link and create the pull request, then approve and merge it:

https://github.com/alterj07/walkpath/compare/main...feat/expansion?expand=1

Your branch rule requires one approving review from a code owner, and you are the only code owner,
so GitHub will not let you approve your own pull request. Two ways through:

- **Simplest:** Settings → Rules → Rulesets → the `main` ruleset → add yourself under
  "Bypass list" → merge the pull request → leave the bypass in place (you are a solo maintainer, so
  the rule is there to stop accidents, not to stop you).
- **Or:** temporarily uncheck "Require a pull request before merging", merge, then switch it back on.

**How to check.** The Actions tab should show a `crawl` run that finishes with a green tick instead
of "cancelled", and `https://walkpath.vercel.app/status` should show a last-run time from within the
last hour.

---

## 2. Summaries and education extraction (optional key, faster results)

**Why it matters.** Two features depend on a model reading each posting: the plain-language summary,
and the education extraction that your eligibility filter runs on. Right now 728 postings are queued
with no summary, which means the "for you" page cannot tell that a job wants a 2027 graduate.

You have three ways to cover this, and **one of them needs nothing from you at all**:

- **Nothing to do:** a second workflow runs a small open model (Qwen 2.5 3B) on GitHub's own runners
  every two hours, measured here at 31 seconds per posting, roughly 1,400 postings per run across
  four parallel runners. This alone clears the backlog in a day and keeps up afterwards. It is on by
  default.
- **Built-in token:** the hourly run also tries GitHub Models with the token Actions already
  provides, about 150 postings a day. No setup.
- **Fastest, and worth the five minutes:** a Mistral key clears thousands per run and is tried
  first when present.

**What to do.** Go to https://console.mistral.ai, create an account (free "Experiment" plan, no
card, phone verification), create an API key, then in GitHub go to Settings → Secrets and variables
→ Actions → New repository secret, name it exactly `MISTRAL_API_KEY`, paste the key.

**Secrets are not published by making the repository public.** They are stored encrypted, cannot be
read back by anyone including you, are never handed to pull requests from forks, and are masked if a
log tries to print them. The repository shows its code and its workflow files, never its secrets.

**How to check.** `/status` shows a non-zero number next to whichever provider ran, and "pending
summaries" falls over the next few hours. Job pages begin showing a summary and an "Eligibility" panel.

---

## 3. Switch on the extra job sources

**Why it matters.** This is the volume question. For comparison, EarlyCareerRadar lists 4,295
internships and 941 new-grad roles, so about 5,200 together. Here is where our listings come from
once step 1 is merged.

| Source | Boards | What it adds |
| --- | --- | --- |
| Greenhouse, Ashby, Lever, Workable | 15,697 | Startups and mid-size tech, the bulk of the board |
| Workday | 4,242 | Large employers (Nissan, Boeing, Cisco, NVIDIA and similar) |
| Oracle Cloud HCM | 1,305 | More large employers; 949 distinct career sites, all validated live |
| SmartRecruiters | 2,832 | Large employers; needs the free key below |
| iCIMS | 296 | Defence, finance and industrial employers |
| SimplifyJobs curated lists | 2 feeds | 7,818 listings in two requests (4,797 internships, 3,021 new-grad), the same lists the comparison sites draw on |

That is 24,374 boards in the registry, up from the 22,601 the first version had, and the curated
lists on their own already exceed the 5,236 roles EarlyCareerRadar shows. Duplicates between a
curated listing and the employer's own board are detected by apply-URL and dropped in favour of the
employer's copy, so the count stays honest.

**What to do.** Two repository variables, set under Settings → Secrets and variables → Actions →
Variables tab (variables, not secrets, since neither is sensitive):

- `WORKDAY_ENABLED` = `true`. It now defaults to on, so you only need this if you ever want it off.
- `SMARTRECRUITERS_API_KEY` (this one is a *secret*, not a variable): sign up at
  https://developers.smartrecruiters.com for a free developer key. Without it those 2,832 boards are
  skipped, because SmartRecruiters' robots file asks generic crawlers to stay away and we respect
  that by only calling it as a registered API client.

**How to check.** `/status` lists every source with boards polled and failures. After a full run you
should see five or six sources with non-zero counts.

---

## 4. Keep the site updating after each crawl

**Why it matters.** Vercel rebuilds when `main` changes, but the hourly run writes job data to a
separate `data` branch, which does not trigger a rebuild. Without this the data is fresh and the
page the visitor sees is not.

**What to do.** In the Vercel project: Settings → Git → Deploy Hooks → create a hook for branch
`main`, copy the URL, and add it in GitHub as a secret named `VERCEL_DEPLOY_HOOK_URL`. Also set
`SITE_URL` = `https://walkpath.vercel.app` as a repository *variable*, which makes feed links, the
sitemap and canonical URLs absolute.

**How to check.** After an hourly run, the Vercel dashboard shows a deployment whose source is a
deploy hook, and the job count on the home page matches `/status`.

---

## 5. Turn on accounts (so saved jobs follow the user between devices)

**Why it matters.** You asked for accounts to back the saving feature. Saved jobs, applied stages,
notes and the resume-derived profile currently live in one browser. With accounts they sync. The
site works fully without this; the account menu simply does not appear.

**What to do.** Full walkthrough is in `docs/accounts.md`. In short:

1. https://console.firebase.google.com → create a project on the free Spark plan (no card).
2. Authentication → Sign-in method → enable **Google** and **Email/Password** with
   "Email link (passwordless)" turned on.
3. Authentication → Settings → Authorized domains → add `walkpath.vercel.app`.
4. Firestore Database → create in production mode.
5. Rules tab → paste the contents of `packages/site/firebase/firestore.rules` → Publish. These rules
   let each signed-in person read and write only their own document and nothing else.
6. Project settings → Your apps → Add web app → copy the four values into **both** Vercel
   environment variables and GitHub repository variables:
   `PUBLIC_FIREBASE_API_KEY`, `PUBLIC_FIREBASE_AUTH_DOMAIN`, `PUBLIC_FIREBASE_PROJECT_ID`,
   `PUBLIC_FIREBASE_APP_ID`. These four are public by design; they identify the project, they do not
   grant access, which is what the rules in step 5 are for.

**How to check.** The header shows "Sign in". Sign in with Google on your phone and your laptop and
confirm a job saved on one appears on the other.

---

## 6. Optional polish

Each of these is genuinely optional and costs nothing.

| What | How | Why you might skip it |
| --- | --- | --- |
| Company logos | Free client ID at https://brandfetch.com/developers → variable `PUBLIC_BRANDFETCH_CLIENT_ID` | Letter avatars are shown instead; also most registry rows have no company domain yet, so coverage is partial |
| Visitor counts | Cloudflare dashboard → Web Analytics → add `walkpath.vercel.app` → variable `PUBLIC_CF_ANALYTICS_TOKEN` | Cookie-free, but you may not care |
| Alerts | A Discord channel webhook as secret `DISCORD_WEBHOOK_URL`; a BotFather bot as `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | The RSS feeds already work with no setup |
| Dead-run alarm | A free Better Stack heartbeat, 90-minute grace, as secret `BETTERSTACK_HEARTBEAT_URL` | `/status` already shows a stale-run warning |
| More free summary capacity | `GEMINI_API_KEY` from Google AI Studio, `GROQ_API_KEY` from Groq | Only useful as a backup; the local model already covers the volume |
| Turn the local model off | Variable `LOCAL_LLM_ENABLED` = `false` | Only if you dislike the extra Actions usage |

---

## 6a. What `scripts/setup-wizard.sh` actually does, stage by stage

You said the earlier directions were vague and did not match the current code. They were: the wizard
was written when the plan targeted Cloudflare Pages, and you deployed on Vercel instead. Here is
what each of its fourteen stages really does and whether it still applies to you. Run it with
`bash scripts/setup-wizard.sh`; it is safe to re-run and skips what it detects as done.

| Stage | What it does | Still applies? |
| --- | --- | --- |
| 1. Preflight | Checks for git, curl, node; offers to install the GitHub CLI so later stages can set secrets for you instead of opening a browser tab | Yes, and installing `gh` makes everything after it much faster |
| 2. Create the `data` branch | Creates an empty orphan branch where the hourly run writes job data | **Already done.** It will detect this and skip |
| 3. Actions permissions | Opens the settings page to restrict which actions may run and make the default token read-only | Yes |
| 4. Code security | Secret scanning, push protection, Dependabot alerts, private vulnerability reporting | Yes |
| 5. Branch rulesets | Sets up the protection on `main` and `data` | **Already done**, and it is what blocks step 1 above. Use the bypass list |
| 6. Cloudflare account and Pages project | Creates a Cloudflare Pages project | **Skip.** You are on Vercel. Press Enter past it |
| 7. Cloudflare tokens | A Pages deploy token and a Workers AI token | **Skip the Pages token.** The Workers AI token is only a backup summary provider you no longer need, since the local model covers it |
| 8. Repository variables | `SITE_URL`, `WORKDAY_ENABLED`, and the optional public ones | Yes. Set `SITE_URL` to your Vercel address |
| 9. LLM provider secrets | Mistral, Gemini, Groq, GitHub Models, each verified against the provider | Optional now. See step 2 above |
| 10. SmartRecruiters key and alert channels | The free developer key, plus Discord and Telegram | The SmartRecruiters key is worth it (2,832 boards); alerts are optional |
| 11. Heartbeat and error reporting | Better Stack heartbeat, Sentry | Optional |
| 12. First run | Triggers the hourly workflow and tells you what to check | Yes, after step 1 |
| 13. Week-one experiments | Prints the commands behind the measurements in the plan | Informational |

Two things the wizard does **not** cover, because they came later: the Vercel deploy hook (step 4
above) and Firebase for accounts (step 5 above).


---

## 7. Decisions I could not make for you

- **Seven Dependabot pull requests are open**, including major version bumps (Astro 7, TypeScript 7,
  ESLint 10). Majors can break the build, so review them yourself. The two action bumps (checkout,
  setup-node) are safe to merge.
- **A full iCIMS seed**: 296 of the 327 portals visible in the curated lists are in the registry.
  Running `node packages/pipeline/scripts/seed-icims.ts` without a cap would add the rest; it takes
  a couple of hours of polite requests, which is why it was capped.
- **Rippling, Eightfold and BambooHR adapters** were deferred; together they are roughly 250 boards,
  the smallest remaining gain.
- **Custom domain**: the only thing in this project that costs money, about ten dollars a year. The
  `.vercel.app` address works fine without it.

---

## 8. How to verify the whole thing end to end

After step 1 and a full hour has passed:

1. `https://walkpath.vercel.app/status` — last run inside the hour, several sources with non-zero
   boards polled, failures low, pending summaries falling if you did step 2.
2. The home page — switch the role toggle between Internships, New grad and All; the count should
   jump well past the current 539.
3. Open any job — the Apply button should lead to the employer's own posting, and the page should
   list the education requirements it extracted.
4. `/profile` — upload your resume; it is parsed in your browser and never uploaded anywhere.
5. `/for-you` — jobs whose graduation window excludes you should be hidden, with a toggle to show
   them and the reason why.
