# Summaries

Every new tech internship or new-grad role gets one LLM call that extracts the structured "Smart
Summary" shown on its job page: two sentences, responsibilities, qualifications, must-have and
nice-to-have skills, plus the education and eligibility fields (plan 4.8). The model never writes
markup: `validateSummaryOutput` rejects any string carrying HTML, a URL, an email address or a
phone number before it can reach a shard, a feed or the page (plan 11.2).

Summaries are never on the critical path. A job publishes immediately with `summary: null` and the
page says "Summary pending"; the backlog drains on later runs.

## Provider order

The publish job walks this chain and uses the first provider that is inside its free-tier caps.

| Order | Provider | Needs | Free limit that binds |
| --- | --- | --- | --- |
| 1 | Mistral (`mistral-small-latest`) | `MISTRAL_API_KEY` | 1 req/s, 30M tokens/day |
| 2 | Gemini (`gemini-2.5-flash-lite`) | `GEMINI_API_KEY` | ~15 req/min, ~500 req/day |
| 3 | Cloudflare Workers AI (Llama 3.2 3B) | `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_AI_TOKEN` | 10,000 neurons/day (~450 jobs) |
| 4 | Groq (`openai/gpt-oss-20b`) | `GROQ_API_KEY` | 1,000 req/day, 200k tokens/day |
| 5 | GitHub Models (`openai/gpt-4o-mini`) | nothing: the publish job's own `GITHUB_TOKEN` with `models: read` | 150 req/day |
| 6 | Local llama.cpp | nothing | the runner's CPU and wall clock |

Rows 1–4 are optional keys. Row 5 works with no setup at all, which is why a fresh clone of this
repository produces summaries on the first hourly run, just slowly (150/day).

## Local model: how the backlog actually drains

`.github/workflows/summarize.yml` runs every two hours (cron `35 */2 * * *`), offset from the
crawl. A `plan` job counts the records with `summary === null` on the `data` branch and asks for one
runner per ~400 pending summaries, up to four. Each runner:

1. downloads a pinned llama.cpp release and a pinned model, both verified by sha256 and cached;
2. starts `llama-server` on `127.0.0.1:8080` with a 4,096-token context and 4 threads;
3. runs `packages/pipeline/scripts/summarize-local.ts --shard k/n --max 400 --deadline-min 45`,
   which writes one `summaries/<id>.json` per job;
4. commits those files to the `data` branch (rebase-retry loop; files are unique per job id, so
   sibling shards never conflict).

The next publish run folds them in (`src/publish/summary-files.ts`) through the same save path as
the API chain, so the LLM gate still decides ambiguous records, then deletes the files. Each file
carries the record's `content_hash`: if the posting changed in the meantime the summary is dropped
and the job is summarized again.

Pinned versions (bump both the tag and the checksum together):

| What | Value |
| --- | --- |
| llama.cpp release | `b11541`, `llama-b11541-bin-ubuntu-x64.tar.gz` |
| archive sha256 | `36ca310be4405acb7ba59b32dbdce32bb9cd7b1ef95358997b7eaed2c6f0188b` |
| model | `Qwen/Qwen2.5-3B-Instruct-GGUF`, `qwen2.5-3b-instruct-q4_k_m.gguf` (Apache-2.0, 2.0 GB) |
| model sha256 | `626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d` |

Output is grammar-constrained: the provider hands llama.cpp a JSON schema derived from
`SummaryOutputSchema`, so replies are structurally valid by construction. The validator still runs.

## Measured throughput

Five real pending records from the `data` branch, on a 16-core desktop with 4 server threads (the
same thread count the workflow uses):

| Measure | Value |
| --- | --- |
| Summaries written | 5 of 5 (validator pass rate 100%) |
| Seconds per summary | 31 average (26 fastest, 41 slowest) |
| Prompt evaluation | ~95 tokens/s |
| Generation | 18.7–19.5 tokens/s |

A GitHub-hosted 4-vCPU runner is slower than this machine, so budget roughly 45–60 s per summary
there: about 50 per runner-hour, or ~200 per two-hour cycle across four runners. The 728-record
backlog clears in about two days; steady state (a few hundred new roles a day) keeps up.

## Cost and limits

Everything above is free. The local path is deliberately bounded so it stays within the GitHub
Actions terms for a public repository: at most four runners for 55 minutes every two hours, only
when there is a backlog, and nothing runs when the queue is empty (`shards=0` skips the matrix).

Disable it with the repository variable `LOCAL_LLM_ENABLED=false`; the API chain and GitHub Models
keep working. Set `max_shards` on a manual dispatch to use fewer runners.

## Data use

Only public job-posting text is sent to any provider, never anything about a visitor. Mistral's
free plan and Google's free tier may use prompts to improve their models; Groq, Workers AI, GitHub
Models and the local model do not. Each stored summary keeps its `model` and `generated_at`, so a
bad summary can be traced and regenerated (plan 10.5).
