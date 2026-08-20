interface Entry<V> {
  value: V;
  expiresAt: number;
}

/** Small LRU with per-entry TTL. No dependencies; good enough for a single-process server. */
export class TtlCache<V> {
  private map = new Map<string, Entry<V>>();

  constructor(
    private maxEntries: number,
    private defaultTtlMs: number,
  ) {}

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    // refresh recency
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, ttlMs = this.defaultTtlMs): void {
    if (this.map.size >= this.maxEntries && !this.map.has(key)) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /** Memoize an async producer under a key. Concurrent callers share one in-flight promise. */
  private inflight = new Map<string, Promise<V>>();

  /**
   * Memoize `load` under `key`. `ttlMs` may be a fixed number or a function of
   * the resolved value — the latter lets callers cache a transient failure (e.g.
   * a null from a timed-out contract read) briefly while keeping a real result
   * long, so one blip does not poison the entry for the cache's lifetime.
   */
  async getOrLoad(
    key: string,
    load: () => Promise<V>,
    ttlMs: number | ((value: V) => number) = this.defaultTtlMs,
  ): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = load()
      .then((v) => {
        this.set(key, v, typeof ttlMs === 'function' ? ttlMs(v) : ttlMs);
        return v;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}

export const MINUTE = 60 * 1000;
export const HOUR = 60 * 60 * 1000;
/** How long to cache a transient negative (null) result before re-checking. */
export const NEGATIVE_TTL = 10 * MINUTE;
export const DAY = 24 * HOUR;
export const FOREVER = 365 * DAY;
