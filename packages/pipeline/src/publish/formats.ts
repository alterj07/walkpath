import { z } from 'zod';
import { ArrangementSchema, AtsSchema, DEGREE_LEVELS, IsoDateTimeSchema, JobIdSchema, RoleFamilySchema } from '../schema/common.ts';
import { JobRecordSchema, type JobRecord } from '../schema/job.ts';

/**
 * File formats published to the data branch and read by the site (plan section 5.1).
 * The site validates these shapes on fetch, so they must not change without a site change.
 */

/** One row of index/latest.json, index/7d.json and index/all.json (~300 bytes per job). */
export const IndexRowSchema = z.object({
  id: JobIdSchema,
  title: z.string(),
  company: z.string(),
  slug: z.string(),
  domain: z.string(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  arrangement: ArrangementSchema,
  family: RoleFamilySchema,
  season: z.string().nullable(),
  posted_at: IsoDateTimeSchema,
  first_seen_at: IsoDateTimeSchema,
  ats: AtsSchema,
  has_salary: z.boolean(),
  citizenship_required: z.boolean().nullable(),
  /** Number of extra locations beyond the primary one. */
  others: z.number().int().nonnegative(),
  /** Education projections so the explore table can hide ineligible rows without loading buckets. */
  grad_min: z.number().int().nullable().default(null),
  grad_max: z.number().int().nullable().default(null),
  /** Lowest degree level the posting accepts ('any' when it accepts any), null when unstated. */
  degree: z.string().nullable().default(null),
  enrolled: z.boolean().nullable().default(null),
});
export type IndexRow = z.infer<typeof IndexRowSchema>;

export const IndexFileSchema = z.object({
  generated_at: IsoDateTimeSchema,
  rows: z.array(IndexRowSchema),
});
export type IndexFile = z.infer<typeof IndexFileSchema>;

export const CompanyEntrySchema = z.object({
  name: z.string(),
  domain: z.string(),
  blurb: z.string().nullable(),
  ats: z.array(AtsSchema),
  careers_url: z.string().nullable(),
  open_count: z.number().int().nonnegative(),
});
export type CompanyEntry = z.infer<typeof CompanyEntrySchema>;

/** companies.json: keyed by company slug. */
export const CompaniesFileSchema = z.record(z.string(), CompanyEntrySchema);
export type CompaniesFile = z.infer<typeof CompaniesFileSchema>;

const CountSchema = z.number().int().nonnegative();

/** meta.json: run stats rendered on /status and in the site header. */
export const MetaSchema = z.object({
  last_run_at: IsoDateTimeSchema,
  run_id: z.string(),
  boards: z.record(z.string(), z.object({ polled: CountSchema, ok: CountSchema, failed: CountSchema })),
  jobs: z.object({ open: CountSchema, new: CountSchema, closed: CountSchema }),
  latency: z.object({ median_min: z.number().nullable(), p90_min: z.number().nullable() }),
  llm: z.record(z.string(), z.object({ requests: CountSchema, tokens: CountSchema })),
  pending_summaries: CountSchema,
  held_for_review: CountSchema,
  schedule: z.object({ started_at: IsoDateTimeSchema, lateness_min: z.number().nullable() }),
});
export type Meta = z.infer<typeof MetaSchema>;

/** jobs/<xx>.json: full records keyed by job id, bucketed by the first two hex chars. */
export const BucketFileSchema = z.record(JobIdSchema, JobRecordSchema);
export type BucketFile = z.infer<typeof BucketFileSchema>;

/** pages.json: the pre-rendered SEO category pages (plan section 5.5). */
export const PagesEntrySchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  kind: z.enum(['family', 'family_season', 'family_remote', 'state', 'company']),
  filter: z.object({
    family: RoleFamilySchema.optional(),
    season: z.string().optional(),
    remote: z.boolean().optional(),
    state: z.string().length(2).optional(),
    slug: z.string().optional(),
  }),
});
export type PagesEntry = z.infer<typeof PagesEntrySchema>;
export const PagesFileSchema = z.array(PagesEntrySchema);

/** Bucket name for a job id: its first two hex characters (256 buckets). */
export function bucketOf(id: string): string {
  return id.slice(0, 2);
}

/** Project a full record onto the index row shape the explore table loads. */
export function toIndexRow(record: JobRecord): IndexRow {
  return {
    id: record.id,
    title: record.title,
    company: record.company.name,
    slug: record.company.slug,
    domain: record.company.domain,
    city: record.location.city,
    state: record.location.state,
    arrangement: record.location.arrangement,
    family: record.role_family,
    season: record.season,
    posted_at: record.posted_at,
    first_seen_at: record.first_seen_at,
    ats: record.source.ats,
    has_salary: record.salary !== null,
    citizenship_required: record.citizenship_required,
    grad_min: record.education?.grad_year_min ?? null,
    grad_max: record.education?.grad_year_max ?? null,
    degree: lowestDegree(record.education?.degree_levels ?? []),
    enrolled: record.education?.enrollment_required ?? null,
    others: record.location.others.length,
  };
}

/** The least demanding degree level in a posting's accepted list; 'any' wins; null when empty. */
export function lowestDegree(levels: readonly string[]): string | null {
  if (levels.length === 0) return null;
  if (levels.includes('any')) return 'any';
  let best: string | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const l of levels) {
    const rank = (DEGREE_LEVELS as readonly string[]).indexOf(l);
    if (rank >= 0 && rank < bestRank) {
      bestRank = rank;
      best = l;
    }
  }
  return best;
}
