import { z } from 'zod';

/**
 * Applicant-tracking systems the registry can hold. Adapters exist for the first six; boards of
 * the others are skipped by the crawl until an adapter lands (plan 3.1).
 */
export const AtsSchema = z.enum([
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'smartrecruiters',
  'workday',
  'recruitee',
  'breezy',
  'pinpoint',
  'teamtailor',
  'personio',
  'bamboohr',
  'jazzhr',
  'jsonld',
  'icims',
]);
export type Ats = z.infer<typeof AtsSchema>;

export const RoleFamilySchema = z.enum([
  'software_engineering',
  'data_ml_ai',
  'it_cloud_security',
  'product',
  'ux_design',
  'hardware_embedded',
  'quant_research',
]);
export type RoleFamily = z.infer<typeof RoleFamilySchema>;

/** Human-readable labels for role families (feeds, alerts, meta). The site keeps its own copy. */
export const FAMILY_LABELS: Readonly<Record<RoleFamily, string>> = {
  software_engineering: 'Software Engineering',
  data_ml_ai: 'Data / ML / AI',
  it_cloud_security: 'IT / Cloud / Security',
  product: 'Product',
  ux_design: 'UX / Design',
  hardware_embedded: 'Hardware / Embedded / EE',
  quant_research: 'Quant / Research',
};

export const ArrangementSchema = z.enum(['in_person', 'hybrid', 'remote', 'unknown']);
export type Arrangement = z.infer<typeof ArrangementSchema>;

/** Season label such as "Summer 2027", "Fall 2026", or "Immediate". */
export const SeasonSchema = z
  .string()
  .regex(/^(?:(?:Summer|Fall|Spring|Winter) 20\d\d|Immediate)$/, 'season must be "<Season> 20YY" or "Immediate"');
export type Season = z.infer<typeof SeasonSchema>;

export const PostedAtSourceSchema = z.enum(['ATS_FIELD', 'WORKDAY_TEXT', 'FIRST_SEEN']);
export type PostedAtSource = z.infer<typeof PostedAtSourceSchema>;

/** ISO 8601 timestamp as produced by Date#toISOString. */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/** 12 lowercase hex chars: the public job id used in URLs. */
export const JobIdSchema = z.string().regex(/^[a-f0-9]{12}$/);

export const SalarySchema = z.object({
  min: z.number().nonnegative().nullable(),
  max: z.number().nonnegative().nullable(),
  currency: z.string().length(3).default('USD'),
  period: z.enum(['hour', 'day', 'week', 'month', 'year']).nullable(),
});
export type Salary = z.infer<typeof SalarySchema>;
