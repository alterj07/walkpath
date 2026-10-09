import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeDiffArtifact, type CrawlReport } from '../../src/crawl/run.ts';
import type { JobEvent } from '../../src/crawl/diff.ts';
import { canonicalKey, jobIdFromKey } from '../../src/ids.ts';
import type { Summarizer } from '../../src/llm/chain.ts';
import type { SummaryOutput } from '../../src/llm/schema.ts';
import { serializeBoards } from '../../src/registry/boards.ts';
import type { Board } from '../../src/schema/board.ts';
import type { JobPostingInput } from '../../src/schema/job.ts';
import { BucketFileSchema, IndexFileSchema, MetaSchema, PagesFileSchema, CompaniesFileSchema } from '../../src/publish/formats.ts';
import { combinedGate, llmGateVerdict } from '../../src/publish/merge.ts';
import { cronLatenessMin, publish, type PublishOptions } from '../../src/publish/orchestrate.ts';
import { buildPagesList } from '../../src/publish/pages.ts';
import { openStore } from '../../src/publish/store.ts';
import { makeRecord } from './record-fixture.ts';

const NOW = new Date('2026-10-09T18:00:00.000Z');
const iso = (hoursAgo: number): string => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();

const BOARDS: Board[] = [
  {
    company_slug: 'rocket-lab',
    company_name: 'Rocket Lab',
    domain: 'rocketlabcorp.com',
    ats: 'greenhouse',
    board_key: 'rocketlab',
    careers_url: 'https://boards.greenhouse.io/rocketlab',
    added_at: '2026-10-01',
    status: 'active',
  },
  {
    company_slug: 'example-ai',
    company_name: 'Example AI',
    domain: '',
    ats: 'lever',
    board_key: 'exampleai',
    careers_url: 'https://jobs.lever.co/exampleai',
    added_at: '2026-10-01',
    status: 'active',
  },
];

interface EventSpec {
  ats: 'greenhouse' | 'lever';
  board: string;
  ext: string;
  title: string;
  kind?: JobEvent['kind'];
  locations?: string[];
  employmentType?: string | null;
  department?: string | null;
  description?: string;
  applyUrl?: string;
  postedHoursAgo?: number;
  firstSeenHoursAgo?: number;
  postedSource?: JobEvent['posted_at_source'];
  hash?: string;
  reqId?: string | null;
}

function event(spec: EventSpec): JobEvent {
  const key = canonicalKey(spec.ats, spec.board, spec.ext);
  const input: JobPostingInput = {
    externalId: spec.ext,
    internalReqId: spec.reqId ?? null,
    title: spec.title,
    descriptionHtml: spec.description ?? '<p>Build <b>software</b> with the team. Requirements: Python. Summer 2027.</p>',
    locations: spec.locations ?? ['Austin, TX'],
    employmentType: spec.employmentType ?? null,
    remoteFlag: null,
    applyUrl: spec.applyUrl ?? (spec.ats === 'greenhouse' ? `https://boards.greenhouse.io/${spec.board}/jobs/${spec.ext}` : `https://jobs.lever.co/${spec.board}/${spec.ext}/apply`),
    hostedUrl: null,
    postedAt: iso(spec.postedHoursAgo ?? 2),
    postedAtSource: spec.postedSource ?? 'ATS_FIELD',
    salary: null,
    department: spec.department ?? null,
    applicationDeadline: null,
  };
  return {
    kind: spec.kind ?? 'new',
    canonical_key: key,
    job_id: jobIdFromKey(key),
    board_id: `${spec.ats}:${spec.board}`,
    ats: spec.ats,
    board_key: spec.board,
    input,
    posted_at: iso(spec.postedHoursAgo ?? 2),
    posted_at_source: spec.postedSource ?? 'ATS_FIELD',
    first_seen_at: iso(spec.firstSeenHoursAgo ?? 1),
    content_hash: spec.hash ?? 'a'.repeat(32),
    internal_req_id: spec.reqId ?? null,
  };
}

function report(events: JobEvent[], closed: string[] = [], reopened: string[] = [], ats = 'greenhouse'): CrawlReport {
  const counts = { polled: 2, ok: 2, failed: 0, partial: 0, skipped: 0, skipped_deadline: 0 };
  const jobs = { new: events.length, changed: 0, closed: closed.length, reopened: reopened.length, reposts: 0 };
  return {
    run_id: 'crawl-api-test',
    kind: 'crawl-api',
    started_at: iso(0.5),
    finished_at: iso(0.3),
    boards: counts,
    per_ats: { [ats]: { ...counts, jobs } },
    jobs,
    events,
    closed_keys: closed,
    reopened_keys: reopened,
    failures: [],
    needs_refingerprint: [],
  };
}

function fakeSummarizer(decide: (title: string) => Partial<SummaryOutput> | 'exhausted' = () => ({})): Summarizer {
  return {
    availableProviders: () => ['fake'],
    summarize: async (job) => {
      const d = decide(job.title);
      if (d === 'exhausted') return { ok: false, reason: 'exhausted' };
      const output: SummaryOutput = {
        summary: 'Two sentence summary. Second sentence.',
        responsibilities: ['Write code'],
        qualifications: ['Python'],
        must_have_skills: ['Python'],
        nice_to_have_skills: [],
        role_family: 'software_engineering',
        is_internship: true,
        season: 'Summer 2027',
        grad_years: [2027],
        citizenship_required: null,
        sponsorship: 'unknown',
        confidence: 0.9,
        ...d,
      };
      return { ok: true, output, provider: 'fake', model: 'fake-1' };
    },
  };
}

const E = {
  swe: event({ ats: 'greenhouse', board: 'rocketlab', ext: '1', title: 'Software Engineer Intern (Summer 2027)' }),
  data: event({ ats: 'greenhouse', board: 'rocketlab', ext: '2', title: 'Data Science Intern', locations: ['Remote - US'], postedHoursAgo: 30 }),
  hw: event({ ats: 'lever', board: 'exampleai', ext: '3', title: 'Firmware Engineering Intern', locations: ['San Jose, CA'], postedHoursAgo: 200 }),
  senior: event({ ats: 'greenhouse', board: 'rocketlab', ext: '4', title: 'Senior Software Engineer' }),
  marketing: event({ ats: 'greenhouse', board: 'rocketlab', ext: '5', title: 'Marketing Intern' }),
  ambiguous: event({ ats: 'lever', board: 'exampleai', ext: '6', title: '2027 Summer Analyst, Technology' }),
  nonUs: event({ ats: 'greenhouse', board: 'rocketlab', ext: '7', title: 'Software Engineer Intern', locations: ['London, UK'] }),
  scam: event({
    ats: 'lever',
    board: 'exampleai',
    ext: '8',
    title: 'Data Entry Internship - Work From Home',
    description: '<p>Earn $500 per day from home. Send a $50 registration fee via gift card to start. Contact us on WhatsApp to apply.</p>',
  }),
  fan1: event({ ats: 'greenhouse', board: 'rocketlab', ext: '9', title: 'Summer 2027 Engineering Internship - Multiple Locations', locations: ['Long Beach, CA'], postedHoursAgo: 5 }),
  fan2: event({ ats: 'greenhouse', board: 'rocketlab', ext: '10', title: 'Summer 2027 Engineering Internship - Multiple Locations', locations: ['Littleton, CO'], postedHoursAgo: 4 }),
  fan3: event({ ats: 'greenhouse', board: 'rocketlab', ext: '11', title: 'Summer 2027 Engineering Internship - Multiple Locations', locations: ['Wallops Island, VA'], postedHoursAgo: 3 }),
  repost: event({ ats: 'greenhouse', board: 'rocketlab', ext: '12', title: 'Machine Learning Intern', kind: 'repost', postedHoursAgo: 50, firstSeenHoursAgo: 49 }),
  badUrl: event({ ats: 'greenhouse', board: 'rocketlab', ext: '13', title: 'Cloud Infrastructure Intern', applyUrl: 'javascript:alert(1)' }),
  unknownBoard: { ...event({ ats: 'greenhouse', board: 'nobody', ext: '14', title: 'Software Intern' }) },
  coop: event({ ats: 'lever', board: 'exampleai', ext: '15', title: 'Embedded Software Co-op (Fall 2026)', locations: ['Boston, MA'] }),
};

let dir: string;
let opts: PublishOptions;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'walkpath-publish-'));
  await writeFile(join(dir, 'boards.csv'), serializeBoards(BOARDS));
  await writeFile(join(dir, 'sources.json'), JSON.stringify({ sources: {}, publish: { enabled: true } }));
  opts = {
    dataDir: join(dir, 'data'),
    artifacts: [join(dir, 'diff-api.json'), join(dir, 'diff-workday.json')],
    boardsPath: join(dir, 'boards.csv'),
    sourcesPath: join(dir, 'sources.json'),
    statePath: join(dir, 'state-publish.sqlite'),
    siteUrl: 'https://walkpath.test',
    now: () => NOW,
    env: {},
    summarizer: fakeSummarizer(),
    alerts: false,
  };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function json<T>(rel: string, schema: { parse: (v: unknown) => T }): Promise<T> {
  return schema.parse(JSON.parse(await readFile(join(dir, 'data', rel), 'utf8')));
}

const allEvents = Object.values(E);

describe('publish orchestrator', () => {
  it('runs end to end over a synthetic artifact', async () => {
    await writeDiffArtifact(report(allEvents), opts.artifacts[0] as string);
    const result = await publish(opts);

    expect(result.skipped).toBe(false);
    expect(result.artifacts_read).toBe(1); // workday artifact missing → skipped
    expect(result.merge.not_intern).toBe(1);
    expect(result.merge.not_tech).toBe(1);
    expect(result.merge.non_us).toBe(1);
    expect(result.merge.held).toBe(1);
    expect(result.merge.unknown_board).toBe(1);
    expect(result.merge.grouped).toBe(2);
    expect(result.merge.ambiguous).toBe(1);
    // swe, data, hw, fan1 (canonical), repost, badUrl, coop = 7 rule-published, + the ambiguous one via the LLM gate.
    expect(result.merge.published).toBe(7);
    expect(result.llm_gate).toEqual({ published: 1, dropped: 0, waiting: 0 });
    expect(result.meta.jobs.new).toBe(8);

    const all = await json('index/all.json', IndexFileSchema);
    expect(all.rows).toHaveLength(8);
    expect(all.rows.map((r) => r.id)).toEqual([...all.rows].sort((a, b) => b.posted_at.localeCompare(a.posted_at)).map((r) => r.id));
    const latest = await json('index/latest.json', IndexFileSchema);
    expect(latest.rows.map((r) => r.title).sort()).toEqual(
      ['2027 Summer Analyst, Technology', 'Cloud Infrastructure Intern', 'Embedded Software Co-op (Fall 2026)', 'Software Engineer Intern (Summer 2027)', 'Summer 2027 Engineering Internship'].sort(),
    );
    const sevenDays = await json('index/7d.json', IndexFileSchema);
    expect(sevenDays.rows).toHaveLength(7); // hw posted 200 h ago is outside 7d

    const fan = all.rows.find((r) => r.id === E.fan1.job_id);
    expect(fan?.others).toBe(2);
    const bucket = await json(`jobs/${E.fan1.job_id.slice(0, 2)}.json`, BucketFileSchema);
    expect(bucket[E.fan1.job_id]?.location.others).toEqual(['Littleton, CO', 'Wallops Island, VA']);
    const grouped = JSON.parse(await readFile(join(dir, 'data', 'grouped.json'), 'utf8')) as Record<string, { canonical: string; location: string }>;
    expect(grouped[E.fan2.job_id]).toEqual({ canonical: E.fan1.job_id, location: 'Littleton, CO' });
    expect(result.latency_excluded).toBe(1); // hw: posted 200 h before first seen

    const swe = (await json(`jobs/${E.swe.job_id.slice(0, 2)}.json`, BucketFileSchema))[E.swe.job_id];
    expect(swe?.role_family).toBe('software_engineering');
    expect(swe?.season).toBe('Summer 2027');
    expect(swe?.summary?.model).toBe('fake/fake-1');
    expect(swe?.description_html).toBe('<p>Build <b>software</b> with the team. Requirements: Python. Summer 2027.</p>');
    const coop = (await json(`jobs/${E.coop.job_id.slice(0, 2)}.json`, BucketFileSchema))[E.coop.job_id];
    expect(coop?.employment_type).toBe('co_op');
    expect(coop?.location).toMatchObject({ city: 'Boston', state: 'MA', country: 'US' });
    const bad = (await json(`jobs/${E.badUrl.job_id.slice(0, 2)}.json`, BucketFileSchema))[E.badUrl.job_id];
    expect(bad?.apply_url_downgraded).toBe(true);
    expect(bad?.apply_url).toBe('https://boards.greenhouse.io/rocketlab');
    const data = (await json(`jobs/${E.data.job_id.slice(0, 2)}.json`, BucketFileSchema))[E.data.job_id];
    expect(data?.location.arrangement).toBe('remote');

    const companies = await json('companies.json', CompaniesFileSchema);
    expect(companies['rocket-lab']?.open_count).toBe(5);
    expect(companies['example-ai']?.open_count).toBe(3);
    expect(companies['example-ai']?.ats).toEqual(['lever']);

    const pages = await json('pages.json', PagesFileSchema);
    expect(pages.filter((p) => p.kind === 'family')).toHaveLength(7);
    expect(pages.find((p) => p.slug === 'state-tx')).toBeTruthy();
    expect(pages.find((p) => p.slug === 'company-rocket-lab')).toBeTruthy();

    const feeds = await readdir(join(dir, 'data', 'feeds'));
    expect(feeds).toContain('all.xml');
    expect(feeds).toContain('state-TX.xml');
    expect(feeds).toContain('remote.xml');
    const allFeed = await readFile(join(dir, 'data', 'feeds', 'all.xml'), 'utf8');
    expect(allFeed).not.toContain('greenhouse.io');
    expect(allFeed).toContain(`https://walkpath.test/job/${E.swe.job_id}`);

    const meta = await json('meta.json', MetaSchema);
    expect(meta.jobs).toEqual({ open: 8, new: 8, closed: 0 });
    expect(meta.boards.greenhouse).toEqual({ polled: 2, ok: 2, failed: 0 });
    expect(meta.latency.median_min).toBe(60);
    expect(meta.held_for_review).toBe(1);
    expect(meta.pending_summaries).toBe(0);
    expect(meta.schedule.lateness_min).toBeNull();

    const held = JSON.parse(await readFile(join(dir, 'data', 'review', 'held.json'), 'utf8')) as Array<{ id: string; signals: string[] }>;
    expect(held).toHaveLength(1);
    expect(held[0]?.id).toBe(E.scam.job_id);
    expect(held[0]?.signals.length).toBeGreaterThan(0);
    const pendingFiles = await readdir(join(dir, 'data', 'pending')).catch(() => []);
    expect(pendingFiles).toEqual([]);
    expect(result.llm?.succeeded).toBe(8);
  });

  it('is idempotent on a second run with the same artifact', async () => {
    await writeDiffArtifact(report(allEvents), opts.artifacts[0] as string);
    await publish(opts);
    const before = await snapshot();
    const second = await publish({ ...opts, now: () => new Date(NOW.getTime() + 3_600_000) });
    expect(second.merge.published).toBe(0);
    expect(second.merge.updated).toBe(8); // the 7 rule-published plus the one the LLM gate admitted
    expect(second.meta.jobs.new).toBe(0);
    const after = await snapshot();
    for (const [file, text] of Object.entries(before)) {
      if (file.startsWith('jobs/')) expect(stripLastSeen(after[file] ?? '')).toBe(stripLastSeen(text));
    }
    expect((await json('index/all.json', IndexFileSchema)).rows).toHaveLength(8);
  });

  it('closes, keeps closed records out of the indexes, and reopens', async () => {
    await writeDiffArtifact(report([E.swe, E.data]), opts.artifacts[0] as string);
    await publish(opts);
    await writeDiffArtifact(report([], [E.swe.canonical_key]), opts.artifacts[0] as string);
    const closedRun = await publish(opts);
    expect(closedRun.merge.closed).toBe(1);
    expect(closedRun.meta.jobs).toEqual({ open: 1, new: 0, closed: 1 });
    const record = (await json(`jobs/${E.swe.job_id.slice(0, 2)}.json`, BucketFileSchema))[E.swe.job_id];
    expect(record?.closed_at).toBe(NOW.toISOString());
    expect((await json('index/all.json', IndexFileSchema)).rows.map((r) => r.id)).toEqual([E.data.job_id]);
    const feed = await readFile(join(dir, 'data', 'feeds', 'all.xml'), 'utf8');
    expect(feed).not.toContain(E.swe.job_id);

    await writeDiffArtifact(report([], [], [E.swe.canonical_key]), opts.artifacts[0] as string);
    const reopened = await publish(opts);
    expect(reopened.merge.reopened).toBe(1);
    expect((await json('index/all.json', IndexFileSchema)).rows).toHaveLength(2);
  });

  it('removes records closed more than 30 days ago', async () => {
    const store = openStore(join(dir, 'data', 'jobs'));
    await store.put(makeRecord({ id: 'aa0000000001', closed_at: new Date(NOW.getTime() - 31 * 86_400_000).toISOString() }));
    await store.put(makeRecord({ id: 'aa0000000002', closed_at: new Date(NOW.getTime() - 29 * 86_400_000).toISOString() }));
    await store.put(makeRecord({ id: 'aa0000000003' }));
    await store.writeChanged();
    const result = await publish(opts);
    expect(result.retention_removed).toBe(1);
    const bucket = await json('jobs/aa.json', BucketFileSchema);
    expect(Object.keys(bucket).sort()).toEqual(['aa0000000002', 'aa0000000003']);
    expect((await json('index/all.json', IndexFileSchema)).rows.map((r) => r.id)).toEqual(['aa0000000003']);
  });

  it('regate mode re-runs the rule gates without the LLM', async () => {
    const store = openStore(join(dir, 'data', 'jobs'));
    await store.put(makeRecord({ id: 'bb0000000001', title_raw: 'Senior Software Engineer', title: 'Senior Software Engineer' }));
    await store.put(makeRecord({ id: 'bb0000000002', title_raw: 'Data Science Intern', role_family: 'software_engineering' }));
    // Admitted earlier via the ATS employment type; the plain title alone must not evict it.
    await store.put(makeRecord({ id: 'bb0000000005', title_raw: 'Software Engineer, University Program', role_family: 'software_engineering' }));
    await store.writeChanged();
    const pending = openStore(join(dir, 'data', 'pending'));
    await pending.put(makeRecord({ id: 'bb0000000003', title_raw: 'Software Engineer Intern', summary: null }));
    await pending.put(makeRecord({ id: 'bb0000000004', title_raw: 'Sales Intern', summary: null }));
    await pending.writeChanged();
    const result = await publish({ ...opts, mode: 'regate', summarizer: fakeSummarizer(() => 'exhausted') });
    expect(result.regated).toEqual({ removed: 2, published: 1 });
    expect(result.llm).toBeNull();
    const bucket = await json('jobs/bb.json', BucketFileSchema);
    expect(Object.keys(bucket).sort()).toEqual(['bb0000000002', 'bb0000000003', 'bb0000000005']);
    expect(bucket['bb0000000002']?.role_family).toBe('data_ml_ai');
  });

  it('keeps a fanned-out record open while sibling locations are still open', async () => {
    await writeDiffArtifact(report([E.fan1, E.fan2, E.fan3]), opts.artifacts[0] as string);
    await publish(opts);
    // The canonical posting (fan1) closes; fan2 and fan3 stay open.
    await writeDiffArtifact(report([], [E.fan1.canonical_key]), opts.artifacts[0] as string);
    const run = await publish(opts);
    expect(run.merge.closed).toBe(0);
    const record = (await json(`jobs/${E.fan1.job_id.slice(0, 2)}.json`, BucketFileSchema))[E.fan1.job_id];
    expect(record?.closed_at).toBeNull();
    expect(record?.location).toMatchObject({ raw: 'Littleton, CO', city: 'Littleton', state: 'CO', others: ['Wallops Island, VA'] });
    expect((await json('index/all.json', IndexFileSchema)).rows).toHaveLength(1);
    // A sibling closes: its location leaves the record.
    await writeDiffArtifact(report([], [E.fan3.canonical_key]), opts.artifacts[0] as string);
    await publish(opts);
    const after = (await json(`jobs/${E.fan1.job_id.slice(0, 2)}.json`, BucketFileSchema))[E.fan1.job_id];
    expect(after?.location.others).toEqual([]);
    const grouped = JSON.parse(await readFile(join(dir, 'data', 'grouped.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(grouped)).toEqual([E.fan2.job_id]);
    // The last sibling closes: nothing is left open, so the record closes.
    await writeDiffArtifact(report([], [E.fan2.canonical_key]), opts.artifacts[0] as string);
    const last = await publish(opts);
    expect(last.merge.closed).toBe(1);
    expect((await json('index/all.json', IndexFileSchema)).rows).toHaveLength(0);
  });

  it('does not re-summarize a job the LLM already rejected unless its content changed', async () => {
    let calls = 0;
    const summarizer = fakeSummarizer((title) => {
      calls += 1;
      return title.includes('Program') ? { is_internship: false, confidence: 0.95 } : {};
    });
    const program = event({ ats: 'lever', board: 'exampleai', ext: '20', title: 'University Program Associate', department: 'Engineering' });
    await writeDiffArtifact(report([program]), opts.artifacts[0] as string);
    const first = await publish({ ...opts, summarizer });
    expect(first.llm_gate.dropped).toBe(1);
    expect(calls).toBe(1);
    await writeDiffArtifact(report([{ ...program, kind: 'changed' }]), opts.artifacts[0] as string);
    const second = await publish({ ...opts, summarizer });
    expect(second.merge.skipped_llm_negative).toBe(1);
    expect(second.merge.ambiguous).toBe(0);
    expect(calls).toBe(1);
    await writeDiffArtifact(report([{ ...program, kind: 'changed', content_hash: 'b'.repeat(32) }]), opts.artifacts[0] as string);
    const third = await publish({ ...opts, summarizer });
    expect(third.merge.ambiguous).toBe(1);
    expect(calls).toBe(2);
  });

  it('keeps a held job out of the store on a repeat changed event', async () => {
    await writeDiffArtifact(report([E.scam]), opts.artifacts[0] as string);
    await publish(opts);
    await writeDiffArtifact(report([{ ...E.scam, kind: 'changed' }]), opts.artifacts[0] as string);
    const run = await publish(opts);
    expect(run.merge.held).toBe(1);
    expect(run.meta.held_for_review).toBe(1);
    expect((await json('index/all.json', IndexFileSchema)).rows).toHaveLength(0);
    const held = JSON.parse(await readFile(join(dir, 'data', 'review', 'held.json'), 'utf8')) as unknown[];
    expect(held).toHaveLength(1);
  });

  it('closing a pending record removes it and its queue entry', async () => {
    await writeDiffArtifact(report([E.ambiguous]), opts.artifacts[0] as string);
    const first = await publish({ ...opts, summarizer: fakeSummarizer(() => 'exhausted') });
    expect(first.meta.pending_summaries).toBe(1);
    await writeDiffArtifact(report([], [E.ambiguous.canonical_key]), opts.artifacts[0] as string);
    const second = await publish({ ...opts, summarizer: fakeSummarizer(() => 'exhausted') });
    expect(second.meta.pending_summaries).toBe(0);
    const pendingFiles = await readdir(join(dir, 'data', 'pending')).catch(() => []);
    expect(pendingFiles).toEqual([]);
  });

  it('writes no job buckets for an empty artifact and skips invalid artifacts and review files', async () => {
    const store = openStore(join(dir, 'data', 'jobs'));
    expect(await store.writeChanged()).toEqual([]);
    await writeDiffArtifact(report([]), opts.artifacts[0] as string);
    await writeFile(opts.artifacts[1] as string, '{"not": "a report"}');
    await mkdir(join(dir, 'data'), { recursive: true });
    await writeFile(join(dir, 'data', 'grouped.json'), '{"x": "not an entry"}');
    const warnings: string[] = [];
    const run = await publish({ ...opts, log: (m) => warnings.push(m) });
    expect(run.artifacts_read).toBe(1);
    expect(run.artifacts_invalid).toBe(1);
    expect(warnings.some((w) => w.includes('artifact invalid'))).toBe(true);
    expect(warnings.some((w) => w.includes('grouped.json') && w.includes('schema'))).toBe(true);
    await expect(readdir(join(dir, 'data', 'jobs'))).rejects.toThrow();
    expect((await json('index/all.json', IndexFileSchema)).rows).toEqual([]);
  });

  it('suppresses alerts when SUPPRESS_ALERTS is set', async () => {
    const calls: string[] = [];
    const fetch = async (url: string): Promise<Response> => {
      calls.push(url);
      return new Response('{}', { status: 200 });
    };
    await writeDiffArtifact(report([E.swe]), opts.artifacts[0] as string);
    const logs: string[] = [];
    const result = await publish({
      ...opts,
      alerts: true,
      fetch,
      log: (m) => logs.push(m),
      env: { DISCORD_WEBHOOK_URL: 'https://discord.test/webhook', SUPPRESS_ALERTS: 'true' },
    });
    expect(result.alerts).toEqual({ discord: 0, telegram: 0 });
    expect(calls).toEqual([]);
    expect(logs).toContain('publish: alerts=false reason=suppressed');
  });

  it('writes nothing when publishing is disabled', async () => {
    await writeFile(join(dir, 'sources.json'), JSON.stringify({ sources: {}, publish: { enabled: false } }));
    await writeDiffArtifact(report([E.swe]), opts.artifacts[0] as string);
    const result = await publish(opts);
    expect(result.skipped).toBe(true);
    await expect(readdir(join(dir, 'data'))).rejects.toThrow();
  });

  it('keeps ambiguous jobs pending until the LLM is confident, and drops confident negatives', async () => {
    const decide = (title: string): Partial<SummaryOutput> | 'exhausted' => {
      if (title.includes('Analyst')) return { confidence: 0.4 };
      if (title.includes('Program')) return { is_internship: false, confidence: 0.95 };
      return {};
    };
    const program = event({ ats: 'lever', board: 'exampleai', ext: '20', title: 'University Program Associate', department: 'Engineering' });
    await writeDiffArtifact(report([E.ambiguous, program]), opts.artifacts[0] as string);
    const first = await publish({ ...opts, summarizer: fakeSummarizer(decide) });
    expect(first.merge.ambiguous).toBe(2);
    expect(first.llm_gate).toEqual({ published: 0, dropped: 1, waiting: 1 });
    expect((await json('index/all.json', IndexFileSchema)).rows).toHaveLength(0);
    const pendingBucket = await json(`pending/${E.ambiguous.job_id.slice(0, 2)}.json`, BucketFileSchema);
    expect(pendingBucket[E.ambiguous.job_id]?.summary).not.toBeNull();
    expect(first.meta.pending_summaries).toBe(0);
  });

  it('leaves jobs queued when every provider is exhausted and publishes them unsummarized', async () => {
    await writeDiffArtifact(report([E.swe, E.data]), opts.artifacts[0] as string);
    const result = await publish({ ...opts, summarizer: fakeSummarizer(() => 'exhausted') });
    expect(result.llm?.exhausted).toBe(true);
    expect(result.meta.pending_summaries).toBe(2);
    expect((await json('index/all.json', IndexFileSchema)).rows).toHaveLength(2);
    const swe = (await json(`jobs/${E.swe.job_id.slice(0, 2)}.json`, BucketFileSchema))[E.swe.job_id];
    expect(swe?.summary).toBeNull();
    // A later run with a working provider fills the summaries in.
    await writeDiffArtifact(report([]), opts.artifacts[0] as string);
    const later = await publish(opts);
    expect(later.llm?.succeeded).toBe(2);
    expect(later.meta.pending_summaries).toBe(0);
  });

  it('posts alerts only for genuinely new records', async () => {
    const calls: string[] = [];
    const fetch = async (url: string): Promise<Response> => {
      calls.push(url);
      return new Response('{}', { status: 200 });
    };
    const sleep = async (): Promise<void> => {};
    await writeDiffArtifact(report([E.swe, E.repost]), opts.artifacts[0] as string);
    const result = await publish({
      ...opts,
      alerts: true,
      fetch,
      sleep,
      env: { DISCORD_WEBHOOK_URL: 'https://discord.test/webhook', TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '1' },
    });
    expect(result.alerts).toEqual({ discord: 1, telegram: 1 });
    expect(calls.filter((u) => u.startsWith('https://discord.test'))).toHaveLength(1);
    expect(calls.filter((u) => u.includes('api.telegram.org'))).toHaveLength(1);
  });

  it('counts cron lateness only for scheduled runs', () => {
    expect(cronLatenessMin('2026-10-09T18:19:30.000Z', 'schedule')).toBe(2.5);
    expect(cronLatenessMin('2026-10-09T18:05:00.000Z', 'schedule')).toBe(48);
    expect(cronLatenessMin('2026-10-09T18:19:30.000Z', 'workflow_dispatch')).toBeNull();
  });
});

describe('combinedGate', () => {
  it('maps rule verdicts to the state gate', () => {
    expect(combinedGate('Software Engineer Intern', null, null)).toMatchObject({ gate: 'tech_intern', family: 'software_engineering' });
    expect(combinedGate('Senior Intern Coordinator', null, null).gate).toBe('not_intern');
    expect(combinedGate('Marketing Intern', null, null).gate).toBe('not_tech');
    expect(combinedGate('2027 Summer Analyst', null, null).gate).toBe('ambiguous');
    expect(combinedGate('Research Co-op', 'Intern', 'Engineering')).toMatchObject({ gate: 'ambiguous', employment_type: 'co_op' });
  });

  it('llm gate thresholds', () => {
    expect(llmGateVerdict({ is_internship: true, role_family: 'data_ml_ai', confidence: 0.7 })).toBe('publish');
    expect(llmGateVerdict({ is_internship: true, role_family: 'data_ml_ai', confidence: 0.69 })).toBe('wait');
    expect(llmGateVerdict({ is_internship: false, role_family: 'data_ml_ai', confidence: 0.9 })).toBe('drop');
    expect(llmGateVerdict({ is_internship: true, role_family: 'not_tech', confidence: 0.9 })).toBe('drop');
  });
});

describe('buildPagesList', () => {
  it('builds family, season, remote, state and company pages deterministically', () => {
    const records = [
      makeRecord({ id: 'c00000000001', location: { raw: 'Austin, TX', city: 'Austin', state: 'TX', country: 'US', arrangement: 'in_person', others: [] } }),
      makeRecord({ id: 'c00000000002', location: { raw: 'Austin, TX', city: 'Austin', state: 'TX', country: 'US', arrangement: 'in_person', others: [] } }),
      makeRecord({ id: 'c00000000003', company: { slug: 'acme', name: 'Acme', domain: '' } }),
      makeRecord({ id: 'c00000000004', closed_at: '2026-10-01T00:00:00.000Z', location: { raw: 'Reno, NV', city: 'Reno', state: 'NV', country: 'US', arrangement: 'in_person', others: [] } }),
    ];
    const pages = buildPagesList(records);
    expect(pages.filter((p) => p.kind === 'family')).toHaveLength(7);
    expect(pages.filter((p) => p.kind === 'family_season')).toHaveLength(7);
    expect(pages.filter((p) => p.kind === 'family_remote')).toHaveLength(7);
    expect(pages.find((p) => p.slug === 'software-engineering-summer-2027')?.filter).toEqual({ family: 'software_engineering', season: 'Summer 2027' });
    const states = pages.filter((p) => p.kind === 'state').map((p) => p.slug);
    expect(states).toEqual(['state-tx', 'state-co']);
    const companies = pages.filter((p) => p.kind === 'company').map((p) => p.slug);
    expect(companies).toEqual(['company-rocket-lab', 'company-acme']);
    expect(pages.find((p) => p.slug === 'state-nv')).toBeUndefined();
    expect(JSON.stringify(buildPagesList(records))).toBe(JSON.stringify(pages));
  });
});

async function snapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (rel: string): Promise<void> => {
    for (const name of await readdir(join(dir, 'data', rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${name.name}` : name.name;
      if (name.isDirectory()) await walk(p);
      else out[p] = await readFile(join(dir, 'data', p), 'utf8');
    }
  };
  await walk('');
  return out;
}

function stripLastSeen(text: string): string {
  return text.replace(/"last_seen_at": "[^"]+"/g, '"last_seen_at": ""');
}
