import { beforeEach, describe, expect, it } from 'vitest';
import {
  PROFILE_KEY,
  SYNCED_KEYS,
  applyLocal,
  mergeDocs,
  mergeProfiles,
  mergeTrackers,
  sanitizeProfileLike,
  syncNow,
  type RemoteStore,
  type SyncedDoc,
} from '../src/lib/sync.ts';
import { TRACKER_KEY, getTracker, saveTracker } from '../src/lib/tracker.ts';

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => {
      m.delete(k);
    },
    setItem: (k: string, v: string) => {
      m.set(k, String(v));
    },
  } as Storage;
}

const A = 'aaaaaaaaaaaa';
const B = 'bbbbbbbbbbbb';

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = fakeStorage();
});

describe('mergeTrackers', () => {
  it('newest entry wins and local notes survive', () => {
    const local = { [A]: { stage: 'saved' as const, at: '2026-10-01T00:00:00.000Z', note: 'mine' } };
    const remote = {
      [A]: { stage: 'applied' as const, at: '2026-10-02T00:00:00.000Z' },
      [B]: { stage: 'saved' as const, at: '2026-10-03T00:00:00.000Z' },
    };
    const m = mergeTrackers(local, remote);
    expect(m[A]).toEqual({ stage: 'applied', at: '2026-10-02T00:00:00.000Z', note: 'mine' });
    expect(m[B]?.stage).toBe('saved');
  });

  it('older remote entries do not overwrite', () => {
    const local = { [A]: { stage: 'offer' as const, at: '2026-10-05T00:00:00.000Z' } };
    const remote = { [A]: { stage: 'saved' as const, at: '2026-10-01T00:00:00.000Z' } };
    expect(mergeTrackers(local, remote)[A]?.stage).toBe('offer');
  });
});

describe('profiles', () => {
  it('validates shape, size and prototype keys', () => {
    expect(sanitizeProfileLike(null)).toBeNull();
    expect(sanitizeProfileLike({ updated_at: 'nope' })).toBeNull();
    expect(sanitizeProfileLike(JSON.parse('{"updated_at":"2026-10-01T00:00:00.000Z","__proto__":{"x":1}}'))).toBeNull();
    expect(sanitizeProfileLike({ updated_at: '2026-10-01T00:00:00.000Z', skills: ['x'] })).toEqual({
      updated_at: '2026-10-01T00:00:00.000Z',
      skills: ['x'],
    });
    expect(sanitizeProfileLike({ updated_at: '2026-10-01T00:00:00.000Z', big: 'x'.repeat(70_000) })).toBeNull();
  });

  it('newest profile wins', () => {
    const a = { updated_at: '2026-10-01T00:00:00.000Z', skills: ['a'] };
    const b = { updated_at: '2026-10-02T00:00:00.000Z', skills: ['b'] };
    expect(mergeProfiles(a, b)).toBe(b);
    expect(mergeProfiles(b, a)).toBe(b);
    expect(mergeProfiles(null, a)).toBe(a);
    expect(mergeProfiles(a, null)).toBe(a);
  });
});

describe('mergeDocs / syncNow', () => {
  it('merges hostile remote data through the validators and writes both sides', async () => {
    saveTracker({ [A]: { stage: 'saved', at: '2026-10-01T00:00:00.000Z', note: 'local' } });
    globalThis.localStorage.setItem(PROFILE_KEY, JSON.stringify({ updated_at: '2026-10-01T00:00:00.000Z', grad_year: 2028 }));
    const remoteDoc: SyncedDoc = {
      [TRACKER_KEY]: {
        [A]: { stage: 'applied', at: '2026-10-02T00:00:00.000Z' },
        'not-an-id': { stage: 'saved', at: '2026-10-02T00:00:00.000Z' },
        [B]: { stage: 'hacked', at: '2026-10-02T00:00:00.000Z' },
      },
      [PROFILE_KEY]: { updated_at: '2026-10-03T00:00:00.000Z', grad_year: 2029, extra: '<script>' },
    };
    const writes: SyncedDoc[] = [];
    const store: RemoteStore = {
      read: async () => remoteDoc,
      write: async (_uid, d) => {
        writes.push(d);
      },
    };
    const merged = await syncNow('uid1', store);
    const tracker = merged[TRACKER_KEY] as Record<string, { stage: string; note?: string }>;
    expect(Object.keys(tracker)).toEqual([A]);
    expect(tracker[A]).toEqual({ stage: 'applied', at: '2026-10-02T00:00:00.000Z', note: 'local' });
    expect((merged[PROFILE_KEY] as { grad_year: number }).grad_year).toBe(2029);
    expect(getTracker()[A]?.stage).toBe('applied');
    expect(JSON.parse(globalThis.localStorage.getItem(PROFILE_KEY) ?? '{}').grad_year).toBe(2029);
    expect(writes).toHaveLength(1);
    expect(Object.keys(writes[0] ?? {}).every((k) => (SYNCED_KEYS as readonly string[]).includes(k))).toBe(true);
  });

  it('an empty remote document keeps local data', async () => {
    saveTracker({ [A]: { stage: 'saved', at: '2026-10-01T00:00:00.000Z' } });
    const merged = mergeDocs(null);
    expect(Object.keys(merged[TRACKER_KEY] as object)).toEqual([A]);
    expect(merged[PROFILE_KEY]).toBeUndefined();
    applyLocal(merged);
    expect(getTracker()[A]?.stage).toBe('saved');
  });
});
