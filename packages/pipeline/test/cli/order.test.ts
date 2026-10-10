import { describe, expect, it } from 'vitest';
import { interleaveBySource, rotateByHour } from '../../src/cli/order.ts';
import { inShard } from '../../src/cli/shard.ts';
import { crawlBoards } from '../../src/crawl/run.ts';
import { openState } from '../../src/state/db.ts';
import type { Board } from '../../src/schema/board.ts';
import { board, fakeAdapter, makeHttp } from '../crawl/fake-adapter.ts';

const mk = (ats: Board['ats'], key: string): Board => board({ ats, board_key: key, company_slug: key });

describe('board ordering', () => {
  it('interleaves round-robin across sources and keeps every board once', () => {
    const boards = [mk('greenhouse', 'g1'), mk('greenhouse', 'g2'), mk('greenhouse', 'g3'), mk('ashby', 'a1'), mk('workable', 'w1'), mk('workable', 'w2')];
    const out = interleaveBySource(boards);
    expect(out.map((b) => b.board_key)).toEqual(['g1', 'a1', 'w1', 'g2', 'w2', 'g3']);
    expect(out).toHaveLength(boards.length);
  });

  it('rotates the start offset by the hour so unreached boards go first next hour', () => {
    const boards = ['a', 'b', 'c', 'd'].map((k) => mk('ashby', k));
    const hour = 3_600_000;
    expect(rotateByHour(boards, 0).map((b) => b.board_key)).toEqual(['a', 'b', 'c', 'd']);
    expect(rotateByHour(boards, 1 * hour).map((b) => b.board_key)).toEqual(['b', 'c', 'd', 'a']);
    expect(rotateByHour(boards, 5 * hour).map((b) => b.board_key)).toEqual(['b', 'c', 'd', 'a']);
    expect(rotateByHour([], 7 * hour)).toEqual([]);
  });
});

describe('sharding never closes jobs on boards outside the shard', () => {
  it('a board left out of this run is not polled and its jobs stay open', async () => {
    const scripts = { acme: { jobs: [{ id: '1', title: 'Intern 1', description: '<p>1</p>', postedAt: '2026-10-09T08:00:00.000Z' }] }, globex: { jobs: [{ id: '2', title: 'Intern 2', description: '<p>2</p>', postedAt: '2026-10-09T08:00:00.000Z' }] } };
    const { adapter } = fakeAdapter(scripts);
    const db = openState(':memory:');
    const all = [board({ board_key: 'acme' }), board({ board_key: 'globex', company_slug: 'globex' })];
    // Run 1: both boards (one shard).
    const first = await crawlBoards({ boards: all, adapters: { greenhouse: adapter }, http: makeHttp(), db });
    expect(first.jobs.new).toBe(2);
    // Run 2: only the shard that contains acme (or globex) is polled.
    const shard = { index: 0, count: 2 };
    const picked = all.filter((b) => inShard(b.ats, b.board_key, shard));
    const left = all.filter((b) => !inShard(b.ats, b.board_key, shard));
    expect(picked.length + left.length).toBe(2);
    const second = await crawlBoards({ boards: picked, adapters: { greenhouse: adapter }, http: makeHttp(), db });
    expect(second.closed_keys).toEqual([]);
    expect(second.jobs.closed).toBe(0);
    for (const b of left) {
      const rows = db.getJobsForBoard(`${b.ats}:${b.board_key}`);
      expect(rows.every((r) => r.closed_at === null)).toBe(true);
    }
    db.close();
  });
});
