import type { SourceAdapter } from '../../src/adapters/types.ts';
import { HttpClient, HttpError } from '../../src/http/client.ts';
import { canonicalKey } from '../../src/ids.ts';
import type { Board } from '../../src/schema/board.ts';
import type { JobPostingInput } from '../../src/schema/job.ts';

/** Minimal raw job for a fake ATS; `detail` is only present after fetchDetail. */
export interface FakeRaw {
  id: string;
  title: string;
  description?: string;
  reqId?: string | null;
  postedAt?: string | null;
  /** Workday-style relative date ("Posted N Days Ago"): resolved against `now`, source WORKDAY_TEXT. */
  daysAgo?: number;
  updated_at?: string;
  location?: string;
  applyUrl?: string;
}

export interface FakeBoardScript {
  /** Jobs the next listJobs returns; throw by setting `fail`. */
  jobs: FakeRaw[];
  fail?: HttpError | Error | null;
  detailFail?: boolean;
  /** Ids whose toInput throws (simulates a payload the adapter cannot map). */
  badIds?: string[];
}

export const board = (overrides: Partial<Board> = {}): Board => ({
  company_slug: 'acme',
  company_name: 'Acme',
  domain: 'acme.com',
  ats: 'greenhouse',
  board_key: 'acme',
  careers_url: 'https://acme.com/careers',
  added_at: '2026-10-01',
  status: 'active',
  ...overrides,
});

export function makeHttp(): HttpClient {
  return new HttpClient({ fetch: async () => new Response('{}'), respectRobots: false });
}

/**
 * A SourceAdapter over an in-memory script keyed by board_key. `withDetail` makes it
 * behave like Greenhouse (light list, description only via fetchDetail).
 */
export function fakeAdapter(scripts: Record<string, FakeBoardScript>, withDetail = false) {
  const calls = { list: 0, detail: 0, detailIds: [] as string[] };
  const toInput = (raw: FakeRaw, b: Board, firstSeenAt: Date, now?: Date): JobPostingInput => {
    if (scripts[b.board_key]?.badIds?.includes(raw.id)) throw new Error(`cannot map ${raw.id}`);
    if (raw.daysAgo !== undefined) {
      const ref = now ?? firstSeenAt;
      const midnight = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate());
      const { daysAgo: _d, ...rest } = raw;
      return {
        ...toInput({ ...rest, postedAt: null }, b, firstSeenAt, now),
        postedAt: new Date(midnight - raw.daysAgo * 86_400_000).toISOString(),
        postedAtSource: 'WORKDAY_TEXT',
      };
    }
    return {
    externalId: raw.id,
    internalReqId: raw.reqId ?? null,
    title: raw.title,
    descriptionHtml: raw.description ?? '',
    locations: raw.location === undefined ? [] : [raw.location],
    employmentType: null,
    remoteFlag: null,
    applyUrl: raw.applyUrl ?? `https://boards.greenhouse.io/acme/jobs/${raw.id}`,
    hostedUrl: null,
    postedAt: raw.postedAt === undefined ? firstSeenAt.toISOString() : raw.postedAt,
    postedAtSource: raw.postedAt === undefined || raw.postedAt === null ? 'FIRST_SEEN' : 'ATS_FIELD',
    salary: null,
    department: null,
    applicationDeadline: null,
    };
  };
  const adapter: SourceAdapter<FakeRaw> = {
    source: 'greenhouse',
    policy: { minDelayMs: 0, maxConcurrencyPerHost: 4, allowedHosts: ['boards.greenhouse.io'] },
    async listJobs(b) {
      calls.list += 1;
      const script = scripts[b.board_key];
      if (script === undefined) throw new HttpError('http_status', 'boards-api.greenhouse.io', 404);
      if (script.fail) throw script.fail;
      // Light list: strip descriptions when behaving like a detail adapter.
      return withDetail ? script.jobs.map(({ description: _d, ...rest }) => rest) : script.jobs;
    },
    parsePostedAt(raw) {
      return raw.postedAt ? new Date(raw.postedAt) : null;
    },
    canonicalKey(raw, b) {
      return canonicalKey('greenhouse', b.board_key, raw.id);
    },
    toInput,
  };
  if (withDetail) {
    adapter.fetchDetail = async (b, raw) => {
      calls.detail += 1;
      calls.detailIds.push(raw.id);
      const script = scripts[b.board_key];
      if (script?.detailFail) throw new HttpError('http_status', 'boards-api.greenhouse.io', 500);
      const full = script?.jobs.find((j) => j.id === raw.id);
      return { ...raw, description: full?.description ?? '' };
    };
  }
  return { adapter: adapter as SourceAdapter, calls };
}

/** A clock that returns a fixed instant until advanced. */
export function clock(startIso = '2026-10-09T12:00:00.000Z') {
  let t = Date.parse(startIso);
  return {
    now: () => new Date(t),
    advanceHours: (h: number) => {
      t += h * 3_600_000;
    },
    advanceDays: (d: number) => {
      t += d * 86_400_000;
    },
    iso: () => new Date(t).toISOString(),
  };
}
