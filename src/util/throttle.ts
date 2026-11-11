/**
 * Politeness layer. Every call to a provider goes through here: one at a time
 * per provider, with a minimum gap between calls, plus short-lived caching.
 */
export class Throttle {
  private chains = new Map<string, Promise<unknown>>();
  private last = new Map<string, number>();

  constructor(private minGapMs: (key: string) => number) {}

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        const gap = this.minGapMs(key);
        const wait = (this.last.get(key) ?? 0) + gap - Date.now();
        // Jitter so calls don't land on a fixed beat.
        if (wait > 0) await new Promise((r) => setTimeout(r, wait + Math.random() * gap * 0.25));
        try {
          return await fn();
        } finally {
          this.last.set(key, Date.now());
        }
      });
    this.chains.set(key, next);
    return next;
  }
}

export class TtlCache<T> {
  private map = new Map<string, { value: T; expires: number }>();
  constructor(private ttlMs: number) {}
  get(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expires) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }
  set(key: string, value: T): void {
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
  }
}
