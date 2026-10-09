import { describe, expect, it } from 'vitest';
import { NO_DEADLINE, deadlineAfter, formatDuration } from '../../src/cli/timing.ts';

describe('deadline', () => {
  it('fires after the given minutes', () => {
    let t = 1_000;
    const d = deadlineAfter(2, () => t);
    expect(d.reached()).toBe(false);
    expect(d.remainingMs()).toBe(120_000);
    t += 119_999;
    expect(d.reached()).toBe(false);
    t += 1;
    expect(d.reached()).toBe(true);
    expect(d.remainingMs()).toBe(0);
  });

  it('NO_DEADLINE never fires', () => {
    expect(NO_DEADLINE.reached()).toBe(false);
  });

  it('formats durations', () => {
    expect(formatDuration(4_200)).toBe('4s');
    expect(formatDuration(125_000)).toBe('2m05s');
  });
});
