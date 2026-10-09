import type { Ats } from '../schema/common.ts';
import type { SourceAdapter } from './types.ts';
import { greenhouseAdapter } from './greenhouse.ts';
import { leverAdapter } from './lever.ts';
import { ashbyAdapter } from './ashby.ts';
import { workableAdapter } from './workable.ts';
import { smartrecruitersAdapter } from './smartrecruiters.ts';
import { workdayAdapter } from './workday.ts';

/**
 * Any adapter, erased over its raw job type (method bivariance makes this assignment sound
 * for our use). The erased type cannot enforce it, so the crawl loop must only ever feed an
 * adapter its own `listJobs` output.
 */
export type AnyAdapter = SourceAdapter<unknown>;

/** Adapters keyed by ATS. The crawl jobs select by `--ats`; Workday runs in its own job. */
export const API_ADAPTERS: Partial<Record<Ats, AnyAdapter>> = {
  greenhouse: greenhouseAdapter,
  lever: leverAdapter,
  ashby: ashbyAdapter,
  workable: workableAdapter,
  smartrecruiters: smartrecruitersAdapter,
  workday: workdayAdapter,
};

export function adapterFor(ats: Ats): AnyAdapter | undefined {
  return API_ADAPTERS[ats];
}

export type { AdapterPolicy, SourceAdapter } from './types.ts';
export { limitsOf } from './types.ts';
export { parseOrThrow } from './parse.ts';
export { greenhouseAdapter, leverAdapter, ashbyAdapter, workableAdapter, smartrecruitersAdapter, workdayAdapter };
