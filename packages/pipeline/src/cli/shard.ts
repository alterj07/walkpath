/**
 * Deterministic board sharding for crawl jobs that cannot cover a source every hour
 * (Lever: one host, Crawl-delay 1, so ~2,200 boards do not fit in 60 minutes). A job runs
 * `--shard k/n` and keeps the boards whose stable hash lands in bucket k; the Lever job
 * passes the UTC hour parity so every board is polled every other hour. Boards outside the
 * shard are simply not polled this run, which the diff engine never confuses with closure.
 */

/** FNV-1a 32-bit over the UTF-8 bytes; small, stable, dependency-free. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export interface Shard {
  index: number;
  count: number;
}

/** Parses `k/n` with 0 <= k < n, n >= 1. Throws on anything else. */
export function parseShard(spec: string): Shard {
  const m = /^(\d+)\/(\d+)$/.exec(spec.trim());
  if (!m) throw new Error(`shard must look like k/n, got "${spec}"`);
  const index = Number(m[1]);
  const count = Number(m[2]);
  if (count < 1 || index >= count) throw new Error(`shard index ${index} out of range for ${count} shards`);
  return { index, count };
}

/** True when the board identified by `ats:board_key` belongs to the shard. */
export function inShard(ats: string, boardKey: string, shard: Shard): boolean {
  if (shard.count === 1) return true;
  return fnv1a32(`${ats}:${boardKey}`) % shard.count === shard.index;
}
