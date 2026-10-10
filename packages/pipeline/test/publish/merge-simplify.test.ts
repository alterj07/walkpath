import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyEvents, buildGroupIndex, buildUrlIndex, urlKey, type GroupedEntry, type HeldEntry } from '../../src/publish/merge.ts';
import { openStore } from '../../src/publish/store.ts';
import { openState } from '../../src/state/db.ts';
import { BoardSchema, type Board } from '../../src/schema/board.ts';
import { canonicalKey, contentHash, jobIdFromKey } from '../../src/ids.ts';
import type { JobEvent } from '../../src/crawl/diff.ts';
import type { JobPostingInput } from '../../src/schema/job.ts';
import { makeRecord } from './record-fixture.ts';

const NOW = new Date('2026-10-10T04:00:00.000Z');
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function board(over: Partial<Board>): Board {
  return BoardSchema.parse({
    company_slug: 'simplifyjobs',
    company_name: 'SimplifyJobs lists',
    domain: '',
    ats: 'simplify',
    board_key: 'summer-internships',
    wd: '',
    careers_url: 'https://github.com/SimplifyJobs/Summer2027-Internships',
    added_at: '2026-10-10',
    status: 'active',
    ...over,
  });
}

function event(b: Board, externalId: string, input: Partial<JobPostingInput>): JobEvent {
  const full: JobPostingInput = {
    externalId,
    internalReqId: null,
    title: 'Software Engineer Intern',
    descriptionHtml: '<p>Listed on the SimplifyJobs Summer Internships list.</p>',
    locations: ['Austin, TX'],
    employmentType: 'Internship',
    remoteFlag: null,
    applyUrl: 'https://jobs.lever.co/acme/123',
    hostedUrl: 'https://jobs.lever.co/acme/123',
    postedAt: '2026-10-09T12:00:00.000Z',
    postedAtSource: 'ATS_FIELD',
    salary: null,
    department: null,
    applicationDeadline: null,
    ...input,
  };
  const key = canonicalKey(b.ats, b.board_key, externalId);
  return {
    kind: 'new',
    canonical_key: key,
    job_id: jobIdFromKey(key),
    board_id: `${b.ats}:${b.board_key}`,
    ats: b.ats,
    board_key: b.board_key,
    input: full,
    posted_at: full.postedAt ?? NOW.toISOString(),
    posted_at_source: full.postedAtSource,
    first_seen_at: NOW.toISOString(),
    content_hash: contentHash({ title: full.title, description: full.descriptionHtml }),
    internal_req_id: null,
  };
}

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'walkpath-merge-simplify-'));
  dirs.push(dir);
  const store = openStore(join(dir, 'jobs'));
  const pending = openStore(join(dir, 'pending'));
  const db = openState(':memory:');
  return { dir, store, pending, db };
}

describe('curated-list rows (simplify) in the merge', () => {
  it('skips a list row whose apply URL is already published from the employer ATS', async () => {
    const { store, pending, db } = await harness();
    // The employer's own Lever copy is already open in the store.
    await store.put(
      makeRecord({
        id: 'aa00000000a1',
        source: { ats: 'lever', board: 'acme', external_id: '123' },
        apply_url: 'https://jobs.lever.co/acme/123',
        company: { slug: 'acme', name: 'Acme', domain: 'acme.com' },
      }),
    );
    const b = board({});
    const dup = event(b, 'dup-1', { companyName: 'Acme', applyUrl: 'https://jobs.lever.co/acme/123?utm_source=Simplify' });
    const fresh = event(b, 'fresh-1', { companyName: 'Northwind Labs', applyUrl: 'https://jobs.ashbyhq.com/northwind/abc/application', hostedUrl: null });
    const held: HeldEntry[] = [];
    const grouped: Record<string, GroupedEntry> = {};
    const result = await applyEvents({
      events: [dup, fresh],
      closedKeys: [],
      reopenedKeys: [],
      boardsById: new Map([[`${b.ats}:${b.board_key}`, b]]),
      now: NOW,
      db,
      store,
      pending,
      held,
      grouped,
      groups: await buildGroupIndex(store),
      urls: await buildUrlIndex(store),
    });
    expect(result.counts.deduped_listing).toBe(1);
    expect(result.published.map((r) => r.source.external_id)).toEqual(['fresh-1']);
    expect(await store.get(dup.job_id)).toBeNull();
    const published = await store.get(fresh.job_id);
    expect(published?.company).toEqual({ slug: 'northwind-labs', name: 'Northwind Labs', domain: '' });
    expect(published?.source.ats).toBe('simplify');
    expect(published?.apply_url).toBe('https://jobs.ashbyhq.com/northwind/abc/application');
    db.close();
  });

  it('keeps a list row when no ATS copy exists, and ATS rows published in the same run win over later list rows', async () => {
    const { store, pending, db } = await harness();
    const lever = board({ ats: 'lever', board_key: 'acme', company_slug: 'acme', company_name: 'Acme', domain: 'acme.com', careers_url: 'https://jobs.lever.co/acme' });
    const list = board({});
    const atsEvent = event(lever, '777', { applyUrl: 'https://jobs.lever.co/acme/777', hostedUrl: 'https://jobs.lever.co/acme/777', postedAt: '2026-10-08T12:00:00.000Z' });
    const listEvent = event(list, 'l-777', { companyName: 'Acme', applyUrl: 'https://jobs.lever.co/acme/777?ref=Simplify', postedAt: '2026-10-09T12:00:00.000Z' });
    const result = await applyEvents({
      events: [listEvent, atsEvent],
      closedKeys: [],
      reopenedKeys: [],
      boardsById: new Map([
        [`${lever.ats}:${lever.board_key}`, lever],
        [`${list.ats}:${list.board_key}`, list],
      ]),
      now: NOW,
      db,
      store,
      pending,
      held: [],
      grouped: {},
      groups: await buildGroupIndex(store),
      urls: await buildUrlIndex(store),
    });
    expect(result.counts.deduped_listing).toBe(1);
    expect(result.published.map((r) => r.source.ats)).toEqual(['lever']);
    db.close();
  });

  it('url index ignores closed records and listing-sourced records; urlKey normalises host case and fragments', async () => {
    const { store } = await harness();
    await store.put(makeRecord({ id: 'bb00000000b1', apply_url: 'https://Jobs.Lever.co/acme/1#x', closed_at: null }));
    await store.put(makeRecord({ id: 'bb00000000b2', apply_url: 'https://jobs.lever.co/acme/2', closed_at: '2026-10-01T00:00:00.000Z' }));
    await store.put(makeRecord({ id: 'bb00000000b3', apply_url: 'https://jobs.lever.co/acme/3', source: { ats: 'simplify', board: 'summer-internships', external_id: 'x' } }));
    const urls = await buildUrlIndex(store);
    expect([...urls.keys()]).toEqual(['https://jobs.lever.co/acme/1']);
    expect(urlKey('https://JOBS.lever.co/acme/1/#frag')).toBe('https://jobs.lever.co/acme/1');
    expect(urlKey('nope')).toBeNull();
  });
});
