/** Per-host limiter: at most `maxConcurrency` in flight and at least `minDelayMs` between starts. */

/** Thrown by `acquire` when the caller's AbortSignal fires while waiting for a slot or a delay. */
export class LimiterAbortError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

function rejectOnAbort(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let onAbort: () => void = () => {};
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => reject(new LimiterAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  // A never-awaited rejection must not surface as unhandled once the race is settled elsewhere.
  promise.catch(() => {});
  return { promise, dispose: () => signal.removeEventListener('abort', onAbort) };
}

export interface HostLimits {
  minDelayMs: number;
  maxConcurrency: number;
}

interface HostState {
  inFlight: number;
  lastStartAt: number;
  queue: Array<() => void>;
  /** Backoff deadline: no request to this host starts before this time. */
  blockedUntil: number;
}

export class HostLimiter {
  private readonly hosts = new Map<string, HostState>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    now: () => number = () => Date.now(),
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.now = now;
    this.sleep = sleep;
  }

  private state(host: string): HostState {
    let s = this.hosts.get(host);
    if (!s) {
      s = { inFlight: 0, lastStartAt: -Infinity, queue: [], blockedUntil: 0 };
      this.hosts.set(host, s);
    }
    return s;
  }

  /** Delay every request to `host` until `now + ms` (used after 429/5xx). */
  block(host: string, ms: number): void {
    const s = this.state(host);
    s.blockedUntil = Math.max(s.blockedUntil, this.now() + ms);
  }

  /**
   * Wait for a slot on `host`. With `signal`, the wait (queue or delay) is cancellable and
   * rejects with LimiterAbortError; the slot is never left reserved after an abort.
   */
  async acquire(host: string, limits: HostLimits, signal?: AbortSignal): Promise<() => void> {
    const s = this.state(host);
    while (true) {
      if (signal?.aborted) throw new LimiterAbortError();
      if (s.inFlight >= limits.maxConcurrency) {
        await this.waitForSlot(s, signal);
        continue;
      }
      const wait = Math.max(s.lastStartAt + limits.minDelayMs - this.now(), s.blockedUntil - this.now());
      if (wait > 0) {
        // Reserve the slot while waiting so other callers do not start ahead of us.
        s.inFlight += 1;
        try {
          await this.sleepUnless(wait, signal);
        } finally {
          s.inFlight -= 1;
          s.queue.shift()?.();
        }
        continue;
      }
      s.inFlight += 1;
      s.lastStartAt = this.now();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        s.inFlight -= 1;
        s.queue.shift()?.();
      };
    }
  }

  private async waitForSlot(s: HostState, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      await new Promise<void>((resolve) => s.queue.push(resolve));
      return;
    }
    let resolver: () => void = () => {};
    const slot = new Promise<void>((resolve) => {
      resolver = resolve;
      s.queue.push(resolve);
    });
    const abort = rejectOnAbort(signal);
    try {
      await Promise.race([slot, abort.promise]);
    } catch (err) {
      // Drop our queue entry so the slot goes to the next waiter.
      const i = s.queue.indexOf(resolver);
      if (i >= 0) s.queue.splice(i, 1);
      throw err;
    } finally {
      abort.dispose();
    }
  }

  private async sleepUnless(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      await this.sleep(ms);
      return;
    }
    const abort = rejectOnAbort(signal);
    try {
      await Promise.race([this.sleep(ms), abort.promise]);
    } finally {
      abort.dispose();
    }
  }
}
