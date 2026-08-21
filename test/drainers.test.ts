import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The drainer blacklist is a safety check whose entire value is recency, and it
 * fails open: `isKnownDrainer` answers `false` both for "checked, not listed" and
 * for "never loaded". So the two things that matter are that a failed load
 * RETRIES SOON rather than leaving the check dark for the full interval, and that
 * a caller never answers from an empty list while a load is already in flight.
 *
 * Module state is per-import, so each test imports a fresh copy.
 */
const ok = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;
const fail = () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;

const LISTED = '0xdeadbeef00000000000000000000000000000001';

async function freshModule() {
  vi.resetModules();
  return import('../src/risk/drainers.js');
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('drainers — a failed load must not leave the check dark for the full interval', () => {
  it('retries within a minute after every source fails, instead of waiting 12 hours', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return fail(); // every source down
    });
    const { isKnownDrainer, drainerListLoaded } = await freshModule();

    expect(await isKnownDrainer(LISTED)).toBe(false); // cold start, all sources down
    expect(drainerListLoaded()).toBe(false); // and it says the list never loaded
    const afterFirst = calls;
    expect(afterFirst).toBeGreaterThan(0);

    // Immediately after: still backing off, no new attempt.
    await isKnownDrainer(LISTED);
    expect(calls).toBe(afterFirst);

    // The sources come back, and we retry a minute later rather than in 12 hours.
    vi.stubGlobal('fetch', async () => {
      calls++;
      return ok([LISTED]);
    });
    vi.setSystemTime(Date.now() + 61_000);

    expect(await isKnownDrainer(LISTED)).toBe(true); // recovered
    expect(drainerListLoaded()).toBe(true);
  });

  it('does not refetch on every call while backing off', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return fail();
    });
    const { isKnownDrainer } = await freshModule();

    for (let i = 0; i < 5; i++) await isKnownDrainer(LISTED);
    // One attempt per source, not one per call: a dark check must not also
    // become a request amplifier against sources that are already failing.
    expect(calls).toBeLessThanOrEqual(2);
  });
});

describe('drainers — concurrent cold-start callers must not skip the check', () => {
  it('every concurrent caller waits for the in-flight load, not just the first', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal('fetch', async () => {
      await gate; // hold the load open so all callers overlap
      return ok([LISTED]);
    });
    const { isKnownDrainer } = await freshModule();

    // Five callers arrive while the very first load is still in flight.
    const inFlight = Promise.all(Array.from({ length: 5 }, () => isKnownDrainer(LISTED)));
    release?.();
    const answers = await inFlight;

    // Previously only the caller that started the load awaited it; the rest fell
    // through to an empty set and answered `false` on a listed drainer.
    expect(answers).toEqual([true, true, true, true, true]);
  });

  it('a successful load is not refetched within the refresh interval', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return ok([LISTED]);
    });
    const { isKnownDrainer } = await freshModule();

    expect(await isKnownDrainer(LISTED)).toBe(true);
    const afterLoad = calls;
    vi.setSystemTime(Date.now() + 60 * 60 * 1000); // an hour later
    expect(await isKnownDrainer(LISTED)).toBe(true);
    expect(calls).toBe(afterLoad); // served from the loaded set
  });
});
