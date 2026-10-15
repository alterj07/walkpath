import { describe, expect, it } from 'vitest';
import {
  canonicalSkill,
  ineligibilityReasons,
  jobFacts,
  lowestDegreeLevel,
  rankJobs,
  scoreJob,
  type MatchJob,
  type MatchProfile,
} from '../../src/publish/match.ts';

const base: MatchProfile = {
  grad_year: 2030,
  degree_level: 'bachelors',
  enrolled: true,
  majors: ['Computer Science'],
  skills: ['Python', 'C++', 'Git'],
  families: ['software_engineering'],
  states: ['CA', 'TX'],
  remote_ok: true,
  citizen: true,
  needs_sponsorship: false,
};

const edu = {
  degree_levels: ['bachelors'],
  grad_year_min: null as number | null,
  grad_year_max: null as number | null,
  enrollment_required: null as boolean | null,
};

function record(over: Partial<MatchJob> = {}): MatchJob {
  return {
    family: 'software_engineering',
    state: 'CA',
    arrangement: 'in_person',
    posted_at: '2026-10-09T12:00:00.000Z',
    citizenship_required: null,
    sponsorship: 'unknown',
    education: { ...edu },
    summary: { must_have_skills: ['Python', 'C++'], nice_to_have_skills: ['Rust'] },
    ...over,
  };
}

function row(over: Partial<MatchJob> = {}): MatchJob {
  return {
    family: 'software_engineering',
    state: 'TX',
    arrangement: 'hybrid',
    posted_at: '2026-10-08T12:00:00.000Z',
    citizenship_required: null,
    grad_min: null,
    grad_max: null,
    degree: null,
    enrolled: null,
    ...over,
  };
}

describe('eligibility', () => {
  it('hides a posting whose graduation window ends before the profile year (2028 job, class of 2030)', () => {
    const r = scoreJob(base, record({ education: { ...edu, grad_year_min: 2027, grad_year_max: 2028 } }));
    expect(r.eligible).toBe(false);
    expect(r.reasons[0]).toContain('through 2028');
    expect(r.reasons[0]).toContain('2030');
  });

  it('hides a posting whose window starts after the profile year', () => {
    const r = scoreJob({ ...base, grad_year: 2026 }, record({ education: { ...edu, grad_year_min: 2027, grad_year_max: 2028 } }));
    expect(r.eligible).toBe(false);
    expect(r.reasons[0]).toContain('from 2027');
  });

  it('keeps a posting whose window includes the profile year', () => {
    const r = scoreJob({ ...base, grad_year: 2028 }, record({ education: { ...edu, grad_year_min: 2027, grad_year_max: 2028 } }));
    expect(r.eligible).toBe(true);
  });

  it('keeps a posting with an open-ended window on the matching side', () => {
    expect(scoreJob(base, record({ education: { ...edu, grad_year_min: 2027, grad_year_max: null } })).eligible).toBe(true);
    expect(scoreJob(base, record({ education: { ...edu, grad_year_min: null, grad_year_max: 2031 } })).eligible).toBe(true);
  });

  it('never disqualifies when the profile has no graduation year', () => {
    expect(scoreJob({ ...base, grad_year: null }, record({ education: { ...edu, grad_year_max: 2025 } })).eligible).toBe(true);
  });

  it('uses the index-row projections when no record education is present', () => {
    expect(scoreJob(base, row({ grad_max: 2028 })).eligible).toBe(false);
    expect(scoreJob(base, row({ grad_min: 2031 })).eligible).toBe(false);
    expect(scoreJob(base, row({ grad_min: 2029, grad_max: 2031 })).eligible).toBe(true);
  });

  it('hides postings that require a higher degree than the profile level', () => {
    const r = scoreJob(base, record({ education: { ...edu, degree_levels: ['masters', 'phd'] } }));
    expect(r.eligible).toBe(false);
    expect(r.reasons[0]).toContain("master's degree");
  });

  it('accepts when the lowest accepted level is at or below the profile level', () => {
    expect(scoreJob(base, record({ education: { ...edu, degree_levels: ['bachelors', 'masters'] } })).eligible).toBe(true);
    expect(scoreJob(base, record({ education: { ...edu, degree_levels: ['associate'] } })).eligible).toBe(true);
    expect(scoreJob({ ...base, degree_level: 'phd' }, record({ education: { ...edu, degree_levels: ['masters'] } })).eligible).toBe(true);
  });

  it("treats 'any' as no degree requirement", () => {
    expect(scoreJob({ ...base, degree_level: 'high_school' }, record({ education: { ...edu, degree_levels: ['any', 'phd'] } })).eligible).toBe(true);
    expect(scoreJob({ ...base, degree_level: 'high_school' }, row({ degree: 'any' })).eligible).toBe(true);
    expect(scoreJob({ ...base, degree_level: 'high_school' }, row({ degree: 'bachelors' })).eligible).toBe(false);
  });

  it('ignores the degree rule when the profile level is unknown', () => {
    expect(scoreJob({ ...base, degree_level: null }, record({ education: { ...edu, degree_levels: ['phd'] } })).eligible).toBe(true);
  });

  it('hides citizenship-required postings from non-citizens only', () => {
    expect(scoreJob({ ...base, citizen: false }, record({ citizenship_required: true })).eligible).toBe(false);
    expect(scoreJob({ ...base, citizen: null }, record({ citizenship_required: true })).eligible).toBe(true);
    expect(scoreJob({ ...base, citizen: false }, record({ citizenship_required: false })).eligible).toBe(true);
  });

  it('hides no-sponsorship postings from profiles that need sponsorship', () => {
    expect(scoreJob({ ...base, needs_sponsorship: true }, record({ sponsorship: 'no' })).eligible).toBe(false);
    expect(scoreJob({ ...base, needs_sponsorship: true }, record({ sponsorship: 'unknown' })).eligible).toBe(true);
    expect(scoreJob({ ...base, needs_sponsorship: null }, record({ sponsorship: 'no' })).eligible).toBe(true);
  });

  it('hides enrollment-required postings from profiles that are not enrolled', () => {
    expect(scoreJob({ ...base, enrolled: false }, record({ education: { ...edu, enrollment_required: true } })).eligible).toBe(false);
    expect(scoreJob({ ...base, enrolled: false }, row({ enrolled: true })).eligible).toBe(false);
    expect(scoreJob({ ...base, enrolled: null }, row({ enrolled: true })).eligible).toBe(true);
  });

  it('lists every reason, not only the first', () => {
    const reasons = ineligibilityReasons(
      { ...base, citizen: false, needs_sponsorship: true, grad_year: 2030 },
      record({ citizenship_required: true, sponsorship: 'no', education: { ...edu, grad_year_max: 2027 } }),
    );
    expect(reasons).toHaveLength(3);
  });
});

describe('scoring', () => {
  it('is deterministic and weights skills, family and location', () => {
    const r = scoreJob(base, record());
    // must-have 2/2 (60) + nice 0/1 (0) + family (15) + location CA (10)
    expect(r.score).toBe(85);
    expect(r.breakdown.matched_skills).toEqual(['Python', 'C++']);
    expect(scoreJob(base, record())).toEqual(r);
  });

  it('gives a neutral half credit when the posting lists no skills (unsummarized)', () => {
    const r = scoreJob(base, record({ summary: null }));
    expect(r.breakdown.skills_must).toBe(0.5);
    // 30 + 7.5 + 15 + 10 = 62.5, rounded half up.
    expect(r.score).toBe(63);
  });

  it('matches skills case-insensitively and through aliases', () => {
    expect(canonicalSkill('JavaScript')).toBe('javascript');
    expect(canonicalSkill('JS')).toBe('javascript');
    expect(canonicalSkill('Node.js')).toBe('node');
    const r = scoreJob({ ...base, skills: ['js', 'golang'] }, record({ summary: { must_have_skills: ['JavaScript', 'Go'], nice_to_have_skills: [] } }));
    expect(r.breakdown.skills_must).toBe(1);
  });

  it('rewards remote postings only when the profile accepts remote', () => {
    expect(scoreJob(base, record({ arrangement: 'remote', state: null })).breakdown.location).toBe(1);
    expect(scoreJob({ ...base, remote_ok: false }, record({ arrangement: 'remote', state: null })).breakdown.location).toBe(0.5);
    expect(scoreJob(base, record({ state: 'NY' })).breakdown.location).toBe(0);
    expect(scoreJob({ ...base, states: [] }, record({ state: 'NY' })).breakdown.location).toBe(0.5);
  });

  it('is neutral on family when the profile lists none', () => {
    expect(scoreJob({ ...base, families: [] }, record()).breakdown.family).toBe(0.5);
    expect(scoreJob(base, record({ family: 'data_ml_ai' })).breakdown.family).toBe(0);
  });

  it('ranks eligible jobs first, then by score, then newest first', () => {
    const jobs = [
      { ...record({ posted_at: '2026-10-01T00:00:00.000Z' }), id: 'old-eligible' },
      { ...record({ education: { ...edu, grad_year_max: 2027 } }), id: 'ineligible-high' },
      { ...record({ posted_at: '2026-10-09T00:00:00.000Z' }), id: 'new-eligible' },
      { ...record({ summary: null, posted_at: '2026-10-05T00:00:00.000Z' }), id: 'low-eligible' },
    ];
    const ranked = rankJobs(base, jobs).map((r) => r.job.id);
    expect(ranked).toEqual(['new-eligible', 'old-eligible', 'low-eligible', 'ineligible-high']);
  });

  it('jobFacts normalizes both shapes', () => {
    expect(jobFacts(row({ degree: 'any', grad_min: 2027 }))).toMatchObject({ degree: null, grad_min: 2027, must_have: [] });
    expect(jobFacts(record({ education: { ...edu, degree_levels: ['phd', 'masters'] } })).degree).toBe('masters');
    expect(lowestDegreeLevel(['unknown-level'])).toBeNull();
  });
});
