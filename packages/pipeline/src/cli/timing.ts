/** Wall-clock deadline helper for the crawl jobs (plan 4.4 budgets). */
export interface Deadline {
  readonly at: number;
  reached(): boolean;
  remainingMs(): number;
}

export function deadlineAfter(minutes: number, now: () => number = Date.now): Deadline {
  const at = now() + minutes * 60_000;
  return {
    at,
    reached: () => now() >= at,
    remainingMs: () => Math.max(0, at - now()),
  };
}

/** A deadline that never fires (local runs without --deadline-min). */
export const NO_DEADLINE: Deadline = {
  at: Number.POSITIVE_INFINITY,
  reached: () => false,
  remainingMs: () => Number.POSITIVE_INFINITY,
};

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
}
