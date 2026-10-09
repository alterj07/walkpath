import { z } from 'zod';
import { AtsSchema } from './common.ts';

export const BoardStatusSchema = z.enum(['active', 'disabled', 'needs_refingerprint']);
export type BoardStatus = z.infer<typeof BoardStatusSchema>;

/** One row of registry/boards.csv. */
const BoardBaseSchema = z.object({
  company_slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be kebab-case'),
  company_name: z.string().trim().min(1),
  /** Bare hostname, or empty when the registry cannot resolve a self-hosted board's company. */
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^(?:(?:[a-z0-9-]+\.)+[a-z]{2,})?$/, 'domain must be a bare hostname or empty'),
  ats: AtsSchema,
  /** ATS-specific board token (Greenhouse token, Lever site, Workday "tenant/site", ...). */
  board_key: z.string().trim().min(1),
  /** Workday only: the N in `{tenant}.wd{N}.myworkdayjobs.com`. Empty for every other ATS. */
  wd: z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  careers_url: z.url({ protocol: /^https?$/ }),
  added_at: z.iso.date(),
  status: BoardStatusSchema.default('active'),
});

/** Registry row with the Workday invariant: `wd` is required when ats === 'workday'. */
export const BoardSchema = BoardBaseSchema.check((ctx) => {
  if (ctx.value.ats === 'workday' && ctx.value.wd === undefined) {
    ctx.issues.push({ code: 'custom', input: ctx.value, path: ['wd'], message: 'wd is required for workday boards' });
  }
});
export type Board = z.infer<typeof BoardSchema>;

/** Stable id for a board inside the state store. */
export function boardId(board: Pick<Board, 'ats' | 'board_key'>): string {
  return `${board.ats}:${board.board_key}`;
}
