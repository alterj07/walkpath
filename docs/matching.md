# Matching and eligibility

WalkPath never asks a model whether a posting fits a student. The summarizer only extracts facts;
the fit itself is decided by the deterministic rules in `packages/pipeline/src/publish/match.ts`,
copied byte-for-byte to `packages/site/src/lib/match.ts` for the browser (npm workspaces cannot
import each other's TypeScript at runtime, so the two files are kept in sync by hand; both are
pure functions with no DOM access, and the pipeline copy carries the unit tests).

## What the summarizer extracts

For every new posting the LLM reads both the required (minimum) and the preferred qualifications
and returns an `education` object plus `is_new_grad`:

| Field | Example source text | Value |
| --- | --- | --- |
| `degree_levels` | "pursuing a Master's or PhD" | `["masters", "phd"]` |
| `majors` | "Bachelor's in CS, CE or related" | `["Computer Science", "Computer Engineering"]` |
| `grad_year_min` / `grad_year_max` | "graduating between Dec 2026 and June 2027" | `2026` / `2027` |
| `gpa_min` | "minimum GPA of 3.0" | `3.0` |
| `enrollment_required` | "must be currently enrolled" | `true` |
| `years_experience_max` | "0-2 years of experience" | `2` |

A field the posting does not state stays `null` or empty; the prompt forbids guessing and the
output validator rejects any string carrying a link, an email address, a phone number or HTML.
Each record keeps the model name and timestamp, so a bad extraction is traceable and can be
regenerated. The job page labels the panel as AI-extracted and says the posting is authoritative.

## The profile

`/profile` collects, in the visitor's browser only: graduation year, current or expected degree
level, enrollment, majors, skills, role families, preferred states, remote preference, and two
optional work-authorization answers. A resume (PDF or text) can fill the form: it is parsed
client-side with pdfjs (bundled from `node_modules`, nothing from a CDN) and never uploaded.
The profile lives in `localStorage` under `walkpath:profile`, is validated on every read, and is
cleared with one button. Signing in syncs that key through the accounts feature; without an
account it stays on the device.

## Eligibility rules

A posting is **ineligible** when any of these holds. Unknown on either side never disqualifies.

1. The graduation window excludes the profile year: `grad_year_max < profile.grad_year` or
   `grad_year_min > profile.grad_year`. A posting for the class of 2028 is hidden from a 2030
   student, which is the case the feature exists for.
2. The lowest accepted degree level is higher than the profile's current or expected level
   (`high_school < associate < bachelors < masters < phd`; `any` never disqualifies).
3. The posting requires US citizenship, a clearance or ITAR eligibility and the profile says the
   visitor is not a citizen.
4. The posting does not sponsor work visas and the profile says sponsorship is needed.
5. The posting requires current enrollment and the profile says the visitor is not enrolled.

Ineligible postings are hidden on `/for-you` behind a "Show N hidden (why)" toggle that reveals
them greyed out with the reasons, so a student can always see what was filtered and why. The
explore table at `/` is unfiltered: it is the full board.

## Score

Eligible postings are ranked 0–100, with no randomness:

| Component | Weight | Rule |
| --- | --- | --- |
| Must-have skills | 60 | Share of the posting's must-have skills the profile lists |
| Nice-to-have skills | 15 | Same, over the preferred skills |
| Role family | 15 | 1 when the family is in the profile, 0 otherwise |
| Location | 10 | 1 for a preferred state, or remote when the profile accepts remote |

Skills match case-insensitively through a small alias table (`js` → `javascript`, `k8s` →
`kubernetes`). A posting with no extracted skills scores a neutral half credit rather than zero, so
unsummarized jobs are not buried. Ties break on `posted_at`, newest first; ineligible postings sort
after every eligible one.

## Privacy

No resume, profile field or match result is sent anywhere. The matcher runs in the browser over the
same public index the explore table loads. The only data the pipeline stores about a posting's
requirements is what the employer published.
