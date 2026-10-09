import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LAST_VISIT_KEY,
  TRACKER_KEY,
  clearTracker,
  getLastVisit,
  getTracker,
  removeEntry,
  sanitizeTracker,
  setNote,
  setStage,
  touchLastVisit,
} from '../src/lib/tracker.ts';

class MemoryStorage {
  private map = new Map<string, string>();
  throwOnWrite = false;
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { if (this.throwOnWrite) throw new Error('QuotaExceededError'); this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

const g = globalThis as unknown as { localStorage?: unknown };
let store: MemoryStorage;
const ID = 'a9f3c2e17b04';
const ID2 = '0123456789ab';

beforeEach(() => {
  store = new MemoryStorage();
  g.localStorage = store;
});
afterEach(() => {
  delete g.localStorage;
});

describe('tracker', () => {
  it('starts empty and stores stages', () => {
    expect(getTracker()).toEqual({});
    const now = new Date('2026-10-09T18:00:00Z');
    const t = setStage(ID, 'saved', now);
    expect(t[ID]).toEqual({ stage: 'saved', at: '2026-10-09T18:00:00.000Z' });
    expect(JSON.parse(store.getItem(TRACKER_KEY) ?? '{}')[ID].stage).toBe('saved');
    setStage(ID, 'applied', now);
    expect(getTracker()[ID]?.stage).toBe('applied');
  });

  it('keeps the note when the stage changes and caps notes', () => {
    setStage(ID, 'saved');
    setNote(ID, 'x'.repeat(600));
    expect(getTracker()[ID]?.note).toHaveLength(500);
    setStage(ID, 'interviewing');
    expect(getTracker()[ID]?.note).toHaveLength(500);
    setNote(ID, '   ');
    expect(getTracker()[ID]?.note).toBeUndefined();
    setNote(ID, 'a\u0000b\u0007c');
    expect(getTracker()[ID]?.note).toBe('abc');
    expect(setNote('ffffffffffff', 'nope')['ffffffffffff']).toBeUndefined();
  });

  it('removes entries and clears everything', () => {
    setStage(ID, 'saved');
    setStage(ID2, 'offer');
    expect(Object.keys(removeEntry(ID))).toEqual([ID2]);
    touchLastVisit(new Date('2026-10-09T18:00:00Z'));
    clearTracker();
    expect(store.getItem(TRACKER_KEY)).toBeNull();
    expect(store.getItem(LAST_VISIT_KEY)).toBeNull();
  });

  it('rejects bad ids and stages', () => {
    expect(setStage('not-an-id', 'saved')).toEqual({});
    expect(setStage(ID, 'bookmarked' as never)).toEqual({});
  });

  it('validates whatever is in storage', () => {
    store.setItem(TRACKER_KEY, JSON.stringify({
      [ID]: { stage: 'saved', at: '2026-10-09T18:00:00Z', note: 'ok <b>bold</b>' },
      [ID2]: { stage: 'hacked', at: '2026-10-09T18:00:00Z' },
      'zzzzzzzzzzzz': { stage: 'saved', at: '2026-10-09T18:00:00Z' },
      'ABCDEFABCDEF': { stage: 'saved', at: '2026-10-09T18:00:00Z' },
      'cccccccccccc': { stage: 'saved', at: 'never' },
      'dddddddddddd': 'string',
    }));
    const t = getTracker();
    expect(Object.keys(t)).toEqual([ID]);
    expect(t[ID]?.note).toBe('ok <b>bold</b>');
  });

  it('survives corrupt JSON, arrays and missing storage', () => {
    store.setItem(TRACKER_KEY, '{not json');
    expect(getTracker()).toEqual({});
    expect(sanitizeTracker([])).toEqual({});
    expect(sanitizeTracker(null)).toEqual({});
    delete g.localStorage;
    expect(getTracker()).toEqual({});
    expect(setStage(ID, 'saved')[ID]?.stage).toBe('saved');
    expect(getLastVisit()).toBeNull();
    expect(() => touchLastVisit()).not.toThrow();
  });

  it('survives a storage that throws on write', () => {
    store.throwOnWrite = true;
    expect(() => setStage(ID, 'saved')).not.toThrow();
    expect(() => touchLastVisit()).not.toThrow();
  });

  it('strips control characters from notes and caps entry count', () => {
    const t = sanitizeTracker({ [ID]: { stage: 'saved', at: '2026-10-09T18:00:00Z', note: 'a\u0000b\u0007c\nd' } });
    expect(t[ID]?.note).toBe('abc\nd');
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 5100; i += 1) {
      many[i.toString(16).padStart(12, '0')] = { stage: 'saved', at: '2026-10-09T18:00:00Z' };
    }
    expect(Object.keys(sanitizeTracker(many))).toHaveLength(5000);
  });

  it('tracks the last visit', () => {
    expect(getLastVisit()).toBeNull();
    touchLastVisit(new Date('2026-10-09T18:00:00Z'));
    expect(getLastVisit()).toBe(Date.parse('2026-10-09T18:00:00Z'));
    store.setItem(LAST_VISIT_KEY, 'garbage');
    expect(getLastVisit()).toBeNull();
  });
});
