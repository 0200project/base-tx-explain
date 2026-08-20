import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOREVER, NEGATIVE_TTL, TtlCache } from '../src/cache.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('TtlCache.getOrLoad — per-result TTL', () => {
  it('caches a transient null briefly and re-checks, but caches a real value long', async () => {
    const cache = new TtlCache<string | null>(10, FOREVER);
    let calls = 0;
    // TTL function: nulls expire quickly (self-heal), real values live for FOREVER.
    const ttl = (v: string | null) => (v === null ? NEGATIVE_TTL : FOREVER);

    // First load fails (null) — cached only for NEGATIVE_TTL.
    const loadNull = async () => {
      calls++;
      return null;
    };
    expect(await cache.getOrLoad('k', loadNull, ttl)).toBe(null);
    expect(calls).toBe(1);
    // Within the window: served from cache, no reload.
    expect(await cache.getOrLoad('k', loadNull, ttl)).toBe(null);
    expect(calls).toBe(1);

    // After the negative window, the loader runs again — this time it succeeds.
    vi.advanceTimersByTime(NEGATIVE_TTL + 1000);
    const loadOk = async () => {
      calls++;
      return 'USDC';
    };
    expect(await cache.getOrLoad('k', loadOk, ttl)).toBe('USDC');
    expect(calls).toBe(2);

    // A real value persists far beyond the negative window (effectively forever).
    vi.advanceTimersByTime(30 * 24 * 60 * 60 * 1000); // 30 days
    expect(await cache.getOrLoad('k', loadOk, ttl)).toBe('USDC');
    expect(calls).toBe(2); // no reload
  });

  it('still supports a plain numeric ttl (back-compat)', async () => {
    const cache = new TtlCache<number>(10, 1000);
    let calls = 0;
    const load = async () => {
      calls++;
      return 42;
    };
    expect(await cache.getOrLoad('n', load, 1000)).toBe(42);
    vi.advanceTimersByTime(500);
    expect(await cache.getOrLoad('n', load, 1000)).toBe(42);
    expect(calls).toBe(1);
    vi.advanceTimersByTime(600); // total 1100 > 1000
    expect(await cache.getOrLoad('n', load, 1000)).toBe(42);
    expect(calls).toBe(2); // expired, reloaded
  });
});
