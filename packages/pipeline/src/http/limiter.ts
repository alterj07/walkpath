/** Per-host limiter: at most `maxConcurrency` in flight and at least `minDelayMs` between starts. */

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

  async acquire(host: string, limits: HostLimits): Promise<() => void> {
    const s = this.state(host);
    while (true) {
      if (s.inFlight >= limits.maxConcurrency) {
        await new Promise<void>((resolve) => s.queue.push(resolve));
        continue;
      }
      const wait = Math.max(s.lastStartAt + limits.minDelayMs - this.now(), s.blockedUntil - this.now());
      if (wait > 0) {
        // Reserve the slot while waiting so other callers do not start ahead of us.
        s.inFlight += 1;
        await this.sleep(wait);
        s.inFlight -= 1;
        s.queue.shift()?.();
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
}
