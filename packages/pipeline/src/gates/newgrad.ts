/**
 * Rules-only new-grad / entry-level gate. A sibling of the internship gate: a posting passes the
 * combined gate when it is an internship OR a new-grad role, and tech.
 *
 * Ambiguous titles ("Software Engineer" with no level word) are left for the LLM gate, which reads
 * the posting and returns `is_new_grad` plus `years_experience_max` (see src/llm/schema.ts).
 */
export type NewGradVerdict = 'new_grad' | 'not_new_grad' | 'ambiguous';

export interface NewGradGateInput {
  title: string;
  employmentType?: string | null | undefined;
  description?: string | null | undefined;
}

export interface NewGradGateResult {
  verdict: NewGradVerdict;
  reason: string;
}

const NEW_GRAD_RE =
  /\b(new[ -]?grad(uate)?s?|entry[- ]level|early[- ]career|early[- ]talent|university grad(uate)?|college grad(uate)?|recent grad(uate)?|campus hire|graduate (program|programme|scheme|engineer|developer|analyst|associate|software engineer|trainee)|rotational program|rotation program|associate (software|engineer|developer|data)|junior|jr\.?|engineer i\b|developer i\b|analyst i\b|scientist i\b|level i\b|software engineer 1\b|engineer 1\b|(class of|graduating( in)?) 20(2[5-9]|30))\b/i;
// Interns are not new-grad roles (they have their own gate); word boundaries exclude internal/international.
const INTERN_WORD_RE = /\b(intern|interns|internship|internships|co-?op|co-?ops)\b/i;
const SENIOR_RE = /\b(senior|sr\.?|staff|principal|lead|manager|director|vp|vice president|head of|architect|distinguished|fellow)\b/i;
// Only product/program/project manager phrases are masked ("Associate Product Manager" is an entry role);
// every other "manager" title is vetoed as above entry level.
const ROLE_MANAGER_RE = /\b(product|program|project|technical program|technical product)\s+manag(er|ement)\b/gi;
const LEVEL_II_PLUS_RE = /\b(ii|iii|iv|v|2|3|4|5)\b(?!\s*(years?|yrs?))/i;
const MID_LEVEL_RE = /\b(mid[- ]level|intermediate|experienced)\b/i;
const YEARS_RE = /\b(\d+)\s*\+?\s*(?:-\s*\d+\s*)?(?:years?|yrs?)\b/i;
const ABOUT_GRADS_RE = /\b(university|campus|early career|graduate|new grad)\s+(program\s+)?(recruit(er|ing)|manager|coordinator|specialist)\b/i;
// Bare titles that could be entry level; the posting text decides.
const BARE_ROLE_RE =
  /\b(software|data|machine learning|ml|ai|platform|backend|frontend|full[- ]stack|mobile|ios|android|devops|cloud|security|systems|embedded|firmware|hardware|electrical|qa|test|site reliability|product|ux|ui|research)\b.*\b(engineer|developer|scientist|analyst|designer|programmer)\b/i;
const DESC_ENTRY_RE =
  /\b(0\s*(-|to|–)\s*[12]\s*years?|no (prior )?experience (required|necessary)|recent(ly)? graduat(e|ed|ing)|new grad(uate)?s?|entry[- ]level|early[- ]career|bachelor'?s degree\b[^.]{0,60}\b(required|minimum|or equivalent)|class of 20(2[5-9]|30)|graduat(e|ing) (in|by) (20(2[5-9]|30)|(may|june|december) 20(2[5-9]|30)))\b/i;

/** Rules-only new-grad gate. Internships are not new-grad roles. */
export function newGradGate(input: NewGradGateInput): NewGradGateResult {
  const title = input.title.replace(/\s+/g, ' ').trim();
  const type = (input.employmentType ?? '').trim();

  if (INTERN_WORD_RE.test(title) || /\b(intern|internship|co-?op)\b/i.test(type)) {
    return { verdict: 'not_new_grad', reason: 'internship, handled by the internship gate' };
  }
  const about = title.match(ABOUT_GRADS_RE);
  if (about) return { verdict: 'not_new_grad', reason: `role about graduates: ${about[0]}` };
  const cleaned = title.replace(ROLE_MANAGER_RE, ' ');
  const senior = cleaned.match(SENIOR_RE);
  if (senior) return { verdict: 'not_new_grad', reason: `senior title: ${senior[0]}` };
  const years = title.match(YEARS_RE);
  if (years && Number(years[1]) >= 3) return { verdict: 'not_new_grad', reason: `experience in title: ${years[0]}` };
  const mid = title.match(MID_LEVEL_RE);
  if (mid) return { verdict: 'not_new_grad', reason: `mid-level title: ${mid[0]}` };

  const hit = title.match(NEW_GRAD_RE);
  if (hit) return { verdict: 'new_grad', reason: `new-grad word in title: ${hit[0]}` };
  if (/\b(new grad|entry level|graduate)\b/i.test(type)) return { verdict: 'new_grad', reason: `employment type: ${type}` };

  // "Software Engineer II", "Data Scientist 3": a level above entry.
  const level = title.match(LEVEL_II_PLUS_RE);
  if (level) return { verdict: 'not_new_grad', reason: `level above entry: ${level[0]}` };

  if (BARE_ROLE_RE.test(title)) {
    const desc = input.description ?? '';
    const descHit = desc.match(DESC_ENTRY_RE);
    if (descHit) return { verdict: 'ambiguous', reason: `entry-level signal in posting: ${descHit[0].slice(0, 40)}` };
    const descYears = desc.match(/\b(\d+)\s*\+\s*(?:years?|yrs?)\b/i);
    if (descYears && Number(descYears[1]) >= 3) return { verdict: 'not_new_grad', reason: `experience in posting: ${descYears[0]}` };
    return { verdict: 'ambiguous', reason: 'bare role title with no level word' };
  }
  return { verdict: 'not_new_grad', reason: 'no new-grad signal' };
}
