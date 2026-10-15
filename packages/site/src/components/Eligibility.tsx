/**
 * Eligibility panel on a job page: the posting's extracted education requirements
 * (always, when summarized) and, when the visitor has a profile, the deterministic
 * verdict with its reasons. Every value renders as a text node.
 */
import { useEffect, useState } from 'react';
import { degreeLabel, recordToMatchJob, scoreJob, type MatchResult } from '../lib/match.ts';
import { getProfile, hasProfile, type Profile } from '../lib/profile.ts';
import type { JobRecord } from '../lib/records.ts';

function levelsText(levels: readonly string[]): string {
  if (levels.length === 0) return 'Not stated';
  if (levels.includes('any')) return 'Any degree level';
  return levels.map(degreeLabel).join(' or ');
}

function windowText(min: number | null, max: number | null): string {
  if (min === null && max === null) return 'Not stated';
  if (min !== null && max !== null) return min === max ? `Graduating in ${min}` : `Graduating ${min}–${max}`;
  if (min !== null) return `Graduating ${min} or later`;
  return `Graduating by ${max}`;
}

export function requirementRows(job: JobRecord): Array<[string, string]> {
  const e = job.education;
  if (!e) return [];
  return [
    ['Degree level', levelsText(e.degree_levels)],
    ['Majors', e.majors.length > 0 ? e.majors.join(', ') : 'Not stated'],
    ['Graduation window', windowText(e.grad_year_min, e.grad_year_max)],
    ['Minimum GPA', e.gpa_min === null ? 'Not stated' : e.gpa_min.toFixed(1)],
    ['Current enrollment', e.enrollment_required === null ? 'Not stated' : e.enrollment_required ? 'Required' : 'Not required'],
    ['Experience', e.years_experience_max === null ? 'Not stated' : e.years_experience_max === 0 ? 'None required' : `Up to ${e.years_experience_max} years`],
    ['Citizenship / clearance', job.citizenship_required === null ? 'Not stated' : job.citizenship_required ? 'Required' : 'Not required'],
    ['Visa sponsorship', job.sponsorship === 'unknown' ? 'Not stated' : job.sponsorship === 'yes' ? 'Offered' : 'Not offered'],
  ];
}

export function Eligibility({ job }: { job: JobRecord }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  useEffect(() => {
    const p = getProfile();
    setProfile(hasProfile(p) ? p : null);
  }, []);
  const rows = requirementRows(job);
  const match: MatchResult | null = profile ? scoreJob(profile, recordToMatchJob(job)) : null;

  return (
    <section className="eligibility" aria-labelledby="elig-h">
      <h2 id="elig-h">Eligibility</h2>
      {match ? (
        match.eligible ? (
          <p className="callout callout-ok">
            <strong>Nothing in this posting rules you out.</strong> Match score {match.score}/100
            {match.breakdown.matched_skills.length > 0 && ` · skills matched: ${match.breakdown.matched_skills.join(', ')}`}.
          </p>
        ) : (
          <div className="callout callout-warn">
            <p><strong>This posting likely does not fit your profile:</strong></p>
            <ul>{match.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          </div>
        )
      ) : (
        <p className="small muted">
          <a href="/profile">Set up your profile</a> to see whether this posting fits your graduation year, degree and work authorization.
        </p>
      )}
      {rows.length > 0 ? (
        <dl className="req-list">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="small muted">Requirements have not been extracted yet (summary pending). Read the posting below.</p>
      )}
      <p className="small muted">Extracted by AI from the posting's required and preferred qualifications; may be imperfect. The posting is authoritative.</p>
    </section>
  );
}
