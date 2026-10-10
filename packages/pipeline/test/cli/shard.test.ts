import { describe, expect, it } from 'vitest';
import { fnv1a32, inShard, parseShard } from '../../src/cli/shard.ts';

describe('shard', () => {
  it('fnv1a32 is stable across runs (pinned values)', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('lever:palantir')).toBe(fnv1a32('lever:palantir'));
    expect(fnv1a32('lever:palantir')).not.toBe(fnv1a32('lever:palantir2'));
  });

  it('parses k/n and rejects bad specs', () => {
    expect(parseShard('1/2')).toEqual({ index: 1, count: 2 });
    expect(parseShard(' 0/1 ')).toEqual({ index: 0, count: 1 });
    expect(() => parseShard('2/2')).toThrow(/out of range/);
    expect(() => parseShard('x')).toThrow(/k\/n/);
    expect(() => parseShard('1/0')).toThrow();
  });

  it('every board lands in exactly one shard and the split is roughly even', () => {
    const keys = Array.from({ length: 2_000 }, (_, i) => `board-${i}`);
    const shard0 = keys.filter((k) => inShard('lever', k, { index: 0, count: 2 }));
    const shard1 = keys.filter((k) => inShard('lever', k, { index: 1, count: 2 }));
    expect(shard0.length + shard1.length).toBe(keys.length);
    expect(new Set([...shard0, ...shard1]).size).toBe(keys.length);
    expect(Math.abs(shard0.length - shard1.length)).toBeLessThan(200);
    expect(keys.every((k) => inShard('lever', k, { index: 0, count: 1 }))).toBe(true);
  });
});
