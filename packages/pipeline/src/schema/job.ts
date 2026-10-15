import { z } from 'zod';
import {
  EducationSchema,
  ArrangementSchema,
  AtsSchema,
  IsoDateTimeSchema,
  JobIdSchema,
  PostedAtSourceSchema,
  RoleFamilySchema,
  SalarySchema,
  SeasonSchema,
} from './common.ts';

/**
 * The normalized record every adapter emits, before gating, sanitization or
 * enrichment. Strings are raw and untrusted at this layer.
 */
export const JobPostingInputSchema = z.object({
  externalId: z.string().trim().min(1),
  /** Requisition id that survives reposts (Greenhouse internal_job_id, Workday JR number). */
  internalReqId: z.string().trim().min(1).nullish(),
  title: z.string().trim().min(1),
  /** Raw description HTML or text as the ATS returned it. Sanitized later, never shipped raw. */
  descriptionHtml: z.string(),
  /** Raw location strings; one entry per location the ATS lists. */
  locations: z.array(z.string().trim()).default([]),
  employmentType: z.string().trim().nullish(),
  remoteFlag: z.boolean().nullish(),
  applyUrl: z.string().trim().min(1),
  hostedUrl: z.string().trim().min(1).nullish(),
  postedAt: IsoDateTimeSchema.nullable(),
  postedAtSource: PostedAtSourceSchema,
  salary: SalarySchema.nullish(),
  department: z.string().trim().nullish(),
  applicationDeadline: IsoDateTimeSchema.nullish(),
});
export type JobPostingInput = z.infer<typeof JobPostingInputSchema>;

export const JobSummarySchema = z.object({
  text: z.string(),
  responsibilities: z.array(z.string()).max(5),
  qualifications: z.array(z.string()).max(6),
  must_have_skills: z.array(z.string()),
  nice_to_have_skills: z.array(z.string()),
  model: z.string(),
  generated_at: IsoDateTimeSchema,
});
export type JobSummary = z.infer<typeof JobSummarySchema>;

/** The published record written to jobs/<xx>.json (plan section 6.3). */
export const JobRecordSchema = z.object({
  id: JobIdSchema,
  title: z.string(),
  title_raw: z.string(),
  company: z.object({ slug: z.string(), name: z.string(), domain: z.string() }),
  location: z.object({
    raw: z.string(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    country: z.string().nullable(),
    arrangement: ArrangementSchema,
    /** Extra locations when one requisition fans out to many cities. */
    others: z.array(z.string()).default([]),
  }),
  source: z.object({ ats: AtsSchema, board: z.string(), external_id: z.string() }),
  apply_url: z.string(),
  /** Set when the apply URL failed validation and the button must fall back to careers_url. */
  apply_url_downgraded: z.boolean().default(false),
  posted_at: IsoDateTimeSchema,
  posted_at_source: PostedAtSourceSchema,
  first_seen_at: IsoDateTimeSchema,
  last_seen_at: IsoDateTimeSchema,
  closed_at: IsoDateTimeSchema.nullable(),
  employment_type: z.enum(['internship', 'co_op']),
  role_family: RoleFamilySchema,
  season: SeasonSchema.nullable(),
  salary: SalarySchema.nullable(),
  citizenship_required: z.boolean().nullable(),
  sponsorship: z.enum(['yes', 'no', 'unknown']),
  grad_years: z.array(z.number().int()),
  /** Education and experience requirements (LLM-extracted); null until summarized. */
  education: EducationSchema.nullable().default(null),
  summary: JobSummarySchema.nullable(),
  /** Sanitized at publish time; capped at 20 KB. */
  description_html: z.string(),
  content_hash: z.string().regex(/^[a-f0-9]{32}$/),
});
export type JobRecord = z.infer<typeof JobRecordSchema>;
