import { z } from 'zod';
import { EMPTY_EDUCATION, EducationSchema, RoleFamilySchema, SeasonSchema } from '../schema/common.ts';

/**
 * The structured output we ask the summarizer for (plan section 4.8).
 *
 * The model is a free-tier LLM reading untrusted employer text, so the output is
 * treated as data, not markup (plan 11.2). `validateSummaryOutput` is the security
 * control: any string carrying HTML, a URL, an email address or a phone number is
 * rejected before it can reach a shard, a feed, or the page.
 */
export const SUMMARY_MAX_CHARS = 400;
export const LIST_ITEM_MAX_CHARS = 200;
export const SKILL_MAX_CHARS = 40;

const text = (max: number) => z.string().trim().min(1).max(max);

export const SummaryOutputSchema = z.object({
  summary: text(SUMMARY_MAX_CHARS),
  responsibilities: z.array(text(LIST_ITEM_MAX_CHARS)).max(5),
  qualifications: z.array(text(LIST_ITEM_MAX_CHARS)).max(6),
  must_have_skills: z.array(text(SKILL_MAX_CHARS)).max(15),
  nice_to_have_skills: z.array(text(SKILL_MAX_CHARS)).max(15),
  role_family: z.union([RoleFamilySchema, z.literal('not_tech')]),
  is_internship: z.boolean(),
  /** True for entry-level / new-grad full-time roles (0-2 years); false for interns and experienced roles. */
  is_new_grad: z.boolean().default(false),
  season: SeasonSchema.nullable(),
  grad_years: z.array(z.number().int().min(2024).max(2032)).max(6),
  citizenship_required: z.boolean().nullable(),
  sponsorship: z.enum(['yes', 'no', 'unknown']),
  confidence: z.number().min(0).max(1),
  /** Education requirements read from both required and preferred qualifications. */
  education: EducationSchema.default(EMPTY_EDUCATION),
});
export type SummaryOutput = z.infer<typeof SummaryOutputSchema>;

/** Patterns that must never appear in summary text (plan 11.2). */
const UNSAFE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/[<>]/, 'html'],
  [/https?:/i, 'url'],
  [/\bhxxps?\b/i, 'url'],
  [/\bwww\./i, 'url'],
  // Scheme-less links: "evil-site.com/apply", and the usual contact-redirect hosts.
  [/\b[a-z0-9-]+\.(?:com|net|org|io|co|me|ly|gg|xyz|app|dev)\//i, 'url'],
  [/\b(?:t\.me|wa\.me|discord\.gg|bit\.ly)\b/i, 'url'],
  [/\b(?:whatsapp|telegram)\b/i, 'contact'],
  [/@/, 'email'],
  // A real phone shape: optional country code, 3-3-4 digits with common separators.
  [/(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/, 'phone'],
];

/** Zero-width characters a model (or an injected posting) could use to split a pattern. */
const ZERO_WIDTH = new RegExp('[\\u200B-\\u200D\\u2060\\uFEFF]', 'g');
/** Year ranges such as "2026-2027" look like digits runs but are never phone numbers. */
const YEAR_RANGE = new RegExp('20\\d\\d\\s*[-\\u2013]\\s*20\\d\\d', 'g');

export function unsafeStringReason(value: string): string | null {
  const cleaned = value.replace(ZERO_WIDTH, '');
  for (const [re, reason] of UNSAFE_PATTERNS) {
    const subject = reason === 'phone' ? cleaned.replace(YEAR_RANGE, ' ') : cleaned;
    if (re.test(subject)) return reason;
  }
  return null;
}

function collectStrings(value: unknown, path: string, out: Array<[string, string]>): void {
  if (typeof value === 'string') out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => collectStrings(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectStrings(v, path ? `${path}.${k}` : k, out);
  }
}

/** Every free-text string field, at any depth, must pass the unsafe-pattern check. */
export function rejectUnsafeStrings(output: SummaryOutput): { ok: true } | { ok: false; reason: string } {
  const strings: Array<[string, string]> = [];
  collectStrings(output, '', strings);
  for (const [path, s] of strings) {
    // Enum-constrained fields cannot carry injected text.
    if (path === 'role_family' || path === 'season' || path === 'sponsorship' || path.startsWith('education.degree_levels')) continue;
    const reason = unsafeStringReason(s);
    if (reason) return { ok: false, reason: `${path}: ${reason}` };
  }
  return { ok: true };
}

export type ValidationResult = { ok: true; value: SummaryOutput } | { ok: false; reason: string };

/**
 * Parse and screen a raw model output. The reason never contains the model text
 * itself, only zod paths and the pattern class that matched.
 */
export function validateSummaryOutput(raw: unknown): ValidationResult {
  const parsed = SummaryOutputSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    return { ok: false, reason: `schema: ${issues}` };
  }
  const screened = rejectUnsafeStrings(parsed.data);
  if (!screened.ok) return { ok: false, reason: `unsafe: ${screened.reason}` };
  return { ok: true, value: parsed.data };
}
