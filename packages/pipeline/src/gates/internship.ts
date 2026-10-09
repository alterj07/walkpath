export type InternshipVerdict = 'intern' | 'not_intern' | 'ambiguous';

export interface InternshipGateInput {
  title: string;
  employmentType?: string | null | undefined;
}

export interface InternshipGateResult {
  verdict: InternshipVerdict;
  /** 'co_op' when the posting calls itself a co-op, else 'internship'. */
  employment_type: 'internship' | 'co_op';
  reason: string;
}

// Word boundaries exclude "internal", "international", "internet".
const INTERN_WORD_RE = /\b(intern|interns|internship|internships|co-?op|co-?ops)\b/i;
const COOP_RE = /\bco-?ops?\b/i;
const TYPE_INTERN_RE = /\b(intern|internship|co-?op|student|trainee)\b/i;
// "coordinator" catches "Intern Coordinator" / "Internship Program Coordinator": a job about interns, not for them.
const SENIOR_RE = /\b(senior|sr\.?|staff|principal|lead|manager|director|vp|vice president|coordinator)\b/i;
const ROLE_MANAGER_RE =
  /\b(product|program|project|engineering|technical program|technical product|community|account|brand|marketing|partner|category|content|social media|release|delivery|portfolio|supply chain|operations|business|channel|growth|risk|quality)\s+manag(er|ement)\b/gi;
const YEARS_RE =/\b(\d+)\s*\+?\s*(?:-\s*\d+\s*)?(?:years?|yrs?)\b/i;
const AMBIGUOUS_RE = /\b(summer analyst|university program|student|early career|new grad(uate)?|graduate program|graduate scheme|apprentice(ship)?|fellow(ship)?|trainee|rotational program|leadership development program|campus hire|undergraduate|entry[- ]level program)\b/i;
const ABOUT_INTERNS_RE = /\b(intern(ship)?s?)\s+(program\s+)?(manager|coordinator|recruiter|recruiting|lead|supervisor|specialist)\b/i;

/** Rules-only internship gate (plan 4.5). Ambiguous titles are left for the LLM gate. */
export function internshipGate(input: InternshipGateInput): InternshipGateResult {
  const title = input.title.replace(/\s+/g, ' ').trim();
  const type = (input.employmentType ?? '').trim();
  const employment_type: InternshipGateResult['employment_type'] =
    COOP_RE.test(title) || COOP_RE.test(type) ? 'co_op' : 'internship';

  // "Internship Program Manager", "Intern Recruiter": jobs about interns, not for them.
  const aboutInterns = title.match(ABOUT_INTERNS_RE);
  if (aboutInterns) {
    return { verdict: 'not_intern', employment_type, reason: `role about interns: ${aboutInterns[0]}` };
  }
  // "Product Manager Intern" is an internship in product management, not a manager role.
  const seniorHit = title.replace(ROLE_MANAGER_RE, ' ').match(SENIOR_RE);
  if (seniorHit) {
    return { verdict: 'not_intern', employment_type, reason: `senior title: ${seniorHit[0]}` };
  }
  const years = title.match(YEARS_RE);
  if (years && Number(years[1]) >= 3) {
    return { verdict: 'not_intern', employment_type, reason: `experience in title: ${years[0]}` };
  }
  if (INTERN_WORD_RE.test(title)) {
    return { verdict: 'intern', employment_type, reason: 'intern word in title' };
  }
  if (TYPE_INTERN_RE.test(type)) {
    return { verdict: 'intern', employment_type, reason: `employment type: ${type}` };
  }
  const amb = title.match(AMBIGUOUS_RE);
  if (amb) {
    return { verdict: 'ambiguous', employment_type, reason: `ambiguous title: ${amb[0]}` };
  }
  return { verdict: 'not_intern', employment_type, reason: 'no internship signal' };
}
