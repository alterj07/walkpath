import type { Board } from '../schema/board.ts';

/** Round-robin across sources: g1, l1, a1, g2, l2, a2 ... so a deadline hits every source evenly. */
export function interleaveBySource(boards: readonly Board[]): Board[] {
  const bySource = new Map<string, Board[]>();
  for (const b of boards) {
    const list = bySource.get(b.ats) ?? [];
    list.push(b);
    bySource.set(b.ats, list);
  }
  const lists = [...bySource.values()];
  const out: Board[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i += 1) {
    for (const l of lists) if (i < l.length) out.push(l[i]!);
  }
  return out;
}

/** Rotate the start so boards unreached by last hour's deadline come first this hour. */
export function rotateByHour(boards: readonly Board[], nowMs: number): Board[] {
  if (boards.length === 0) return [];
  const offset = Math.floor(nowMs / 3_600_000) % boards.length;
  return [...boards.slice(offset), ...boards.slice(0, offset)];
}
