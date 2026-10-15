/**
 * Deterministic job matching (no model, no randomness): a job is either eligible for a
 * profile or not, with the reasons spelled out, and eligible jobs get a 0–100 score from
 * skills, role family and location. The same logic is copied to
 * packages/site/src/lib/match.ts for the browser; keep the two in sync by hand
 * (workspaces cannot import each other's TypeScript sources at runtime).
 *
 * Eligibility rules (any one makes the job ineligible):
 * - the posting's graduation window excludes the profile's graduation year
 * - the posting requires a higher degree level than the profile's current/expected one
 * - the posting requires citizenship/clearance and the profile is not a citizen
 * - the posting does not sponsor and the profile needs sponsorship
 * - the posting requires current enrollment and the profile is not enrolled
 * A null on either side never disqualifies: unknown is treated as "not stated".
 */

export const DEGREE_RANK: Readonly<Record<string, number>> = {
  high_school: 0,
  associate: 1,
  bachelors: 2,
  masters: 3,
  phd: 4,
};

export interface MatchProfile {
  grad_year: number | null;
  degree_level: 'high_school' | 'associate' | 'bachelors' | 'masters' | 'phd' | null;
  enrolled: boolean | null;
  majors: readonly string[];
  skills: readonly string[];
  families: readonly string[];
  states: readonly string[];
  remote_ok: boolean;
  citizen: boolean | null;
  needs_sponsorship: boolean | null;
}

/** The job facts the matcher reads; both a full JobRecord and an IndexRow can provide them. */
export interface MatchJob {
  family: string;
  state: string | null;
  arrangement: string;
  posted_at: string;
  citizenship_required: boolean | null;
  sponsorship?: 'yes' | 'no' | 'unknown';
  /** Full record shape. */
  education?: {
    degree_levels: readonly string[];
    grad_year_min: number | null;
    grad_year_max: number | null;
    enrollment_required: boolean | null;
  } | null;
  summary?: { must_have_skills: readonly string[]; nice_to_have_skills: readonly string[] } | null;
  /** Index row shape (projections written by the publish step). */
  grad_min?: number | null;
  grad_max?: number | null;
  degree?: string | null;
  enrolled?: boolean | null;
}

export interface JobFacts {
  grad_min: number | null;
  grad_max: number | null;
  /** Lowest accepted degree level, or null when unstated or 'any'. */
  degree: string | null;
  enrolled: boolean | null;
  must_have: readonly string[];
  nice_to_have: readonly string[];
}

export interface MatchBreakdown {
  skills_must: number;
  skills_nice: number;
  family: number;
  location: number;
  matched_skills: string[];
}

export interface MatchResult {
  eligible: boolean;
  reasons: string[];
  score: number;
  breakdown: MatchBreakdown;
}

export const WEIGHTS = { skills_must: 60, skills_nice: 15, family: 15, location: 10 } as const;

/** Lowest level in a degree list, ignoring 'any' and unknown values; null when none. */
export function lowestDegreeLevel(levels: readonly string[]): string | null {
  let best: string | null = null;
  for (const l of levels) {
    if (l === 'any') return null;
    const rank = DEGREE_RANK[l];
    if (rank === undefined) continue;
    if (best === null || rank < (DEGREE_RANK[best] ?? 0)) best = l;
  }
  return best;
}

/** Normalize either job shape into the facts the rules need. */
export function jobFacts(job: MatchJob): JobFacts {
  const edu = job.education ?? null;
  const degreeFromRow = job.degree === 'any' ? null : (job.degree ?? null);
  return {
    grad_min: edu ? edu.grad_year_min : (job.grad_min ?? null),
    grad_max: edu ? edu.grad_year_max : (job.grad_max ?? null),
    degree: edu ? lowestDegreeLevel(edu.degree_levels) : degreeFromRow,
    enrolled: edu ? edu.enrollment_required : (job.enrolled ?? null),
    must_have: job.summary?.must_have_skills ?? [],
    nice_to_have: job.summary?.nice_to_have_skills ?? [],
  };
}

export function normalizeSkill(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.]+$/g, '')
    .trim();
}

const SKILL_ALIASES: Readonly<Record<string, string>> = {
  js: 'javascript',
  ts: 'typescript',
  'node.js': 'node',
  nodejs: 'node',
  'react.js': 'react',
  reactjs: 'react',
  'c plus plus': 'c++',
  cpp: 'c++',
  golang: 'go',
  'k8s': 'kubernetes',
  postgres: 'postgresql',
  'ml': 'machine learning',
  'ai': 'artificial intelligence',
};

export function canonicalSkill(s: string): string {
  const n = normalizeSkill(s);
  return SKILL_ALIASES[n] ?? n;
}

function overlap(profileSkills: ReadonlySet<string>, jobSkills: readonly string[]): { ratio: number; matched: string[] } {
  if (jobSkills.length === 0) return { ratio: 0.5, matched: [] };
  const matched: string[] = [];
  const seen = new Set<string>();
  for (const s of jobSkills) {
    const c = canonicalSkill(s);
    if (seen.has(c)) continue;
    seen.add(c);
    if (profileSkills.has(c)) matched.push(s);
  }
  return { ratio: matched.length / seen.size, matched };
}

/** Eligibility reasons for a profile against a job; empty when eligible. */
export function ineligibilityReasons(profile: MatchProfile, job: MatchJob): string[] {
  const f = jobFacts(job);
  const reasons: string[] = [];
  if (profile.grad_year !== null) {
    if (f.grad_max !== null && f.grad_max < profile.grad_year) {
      reasons.push(`Targets graduates through ${f.grad_max}; you graduate in ${profile.grad_year}`);
    } else if (f.grad_min !== null && f.grad_min > profile.grad_year) {
      reasons.push(`Targets graduates from ${f.grad_min} on; you graduate in ${profile.grad_year}`);
    }
  }
  if (profile.degree_level !== null && f.degree !== null) {
    const need = DEGREE_RANK[f.degree];
    const have = DEGREE_RANK[profile.degree_level];
    if (need !== undefined && have !== undefined && need > have) {
      reasons.push(`Requires at least a ${degreeLabel(f.degree)}; your level is ${degreeLabel(profile.degree_level)}`);
    }
  }
  if (job.citizenship_required === true && profile.citizen === false) {
    reasons.push('Requires US citizenship, a clearance or ITAR eligibility');
  }
  if (job.sponsorship === 'no' && profile.needs_sponsorship === true) {
    reasons.push('Does not sponsor work visas');
  }
  if (f.enrolled === true && profile.enrolled === false) {
    reasons.push('Requires current enrollment in a degree program');
  }
  return reasons;
}

export function degreeLabel(level: string): string {
  switch (level) {
    case 'high_school':
      return 'high school diploma';
    case 'associate':
      return "associate's degree";
    case 'bachelors':
      return "bachelor's degree";
    case 'masters':
      return "master's degree";
    case 'phd':
      return 'PhD';
    default:
      return level;
  }
}

/** Score a job for a profile. Ineligible jobs still get a score so they can be listed when revealed. */
export function scoreJob(profile: MatchProfile, job: MatchJob): MatchResult {
  const f = jobFacts(job);
  const skills = new Set(profile.skills.map(canonicalSkill));
  const must = overlap(skills, f.must_have);
  const nice = overlap(skills, f.nice_to_have);
  const family = profile.families.length === 0 ? 0.5 : profile.families.includes(job.family) ? 1 : 0;
  let location: number;
  if (job.arrangement === 'remote') location = profile.remote_ok ? 1 : 0.5;
  else if (profile.states.length === 0) location = 0.5;
  else location = job.state !== null && profile.states.includes(job.state) ? 1 : 0;
  const score = Math.round(
    must.ratio * WEIGHTS.skills_must + nice.ratio * WEIGHTS.skills_nice + family * WEIGHTS.family + location * WEIGHTS.location,
  );
  const reasons = ineligibilityReasons(profile, job);
  return {
    eligible: reasons.length === 0,
    reasons,
    score,
    breakdown: {
      skills_must: must.ratio,
      skills_nice: nice.ratio,
      family,
      location,
      matched_skills: [...must.matched, ...nice.matched.filter((s) => !must.matched.includes(s))],
    },
  };
}

/**
 * Adapts a published record (whose family and location are nested) to the flat shape the
 * matcher reads. Index rows already have that shape and need no adapter.
 */
export function recordToMatchJob(record: {
  role_family: string;
  location: { state: string | null; arrangement: string };
  posted_at: string;
  citizenship_required: boolean | null;
  sponsorship: 'yes' | 'no' | 'unknown';
  education: NonNullable<MatchJob['education']> | null;
  summary: { must_have_skills: string[]; nice_to_have_skills: string[] } | null;
}): MatchJob {
  return {
    family: record.role_family,
    state: record.location.state,
    arrangement: record.location.arrangement,
    posted_at: record.posted_at,
    citizenship_required: record.citizenship_required,
    sponsorship: record.sponsorship,
    education: record.education,
    summary: record.summary,
  };
}

/** Eligible jobs first, best score first, newest first on ties; ineligible jobs after, same ordering. */
export function rankJobs<T extends MatchJob>(profile: MatchProfile, jobs: readonly T[]): Array<{ job: T; match: MatchResult }> {
  const scored = jobs.map((job) => ({ job, match: scoreJob(profile, job) }));
  scored.sort((a, b) => {
    if (a.match.eligible !== b.match.eligible) return a.match.eligible ? -1 : 1;
    if (a.match.score !== b.match.score) return b.match.score - a.match.score;
    return a.job.posted_at < b.job.posted_at ? 1 : a.job.posted_at > b.job.posted_at ? -1 : 0;
  });
  return scored;
}
