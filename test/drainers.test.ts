import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

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

/**
 * The REAL shape of scamsniffer's blacklist/all.json: an object keyed `address`,
 * NOT a top-level array. Written faithfully rather than conveniently, because the
 * defect this fixture now guards was a source swap where the parse silently
 * returned [] against a different shape — a fixture that accepts anything would
 * have passed straight through it.
 */
const scamsniffer = (addresses: string[]) => ({ address: addresses, domains: [], combined: {} });
/** The darklist source's shape: array of objects carrying `address`. */
const darklist = (addresses: string[]) => addresses.map((address) => ({ address }));
/** The commit-version lookup. Best-effort in the module, so tests may fail it freely. */
const isVersionLookup = (url: string) => url.includes('api.github.com');

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
    vi.stubGlobal('fetch', async (url: string) => {
      if (isVersionLookup(String(url))) return fail(); // version lookup is best-effort
      calls++;
      return ok(String(url).includes('scamsniffer') ? scamsniffer([LISTED]) : darklist([LISTED]));
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
    vi.stubGlobal('fetch', async (url: string) => {
      if (isVersionLookup(String(url))) return fail();
      await gate; // hold the load open so all callers overlap
      return ok(String(url).includes('scamsniffer') ? scamsniffer([LISTED]) : darklist([LISTED]));
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
    vi.stubGlobal('fetch', async (url: string) => {
      if (isVersionLookup(String(url))) return fail(); // version lookup is best-effort
      calls++;
      return ok(String(url).includes('scamsniffer') ? scamsniffer([LISTED]) : darklist([LISTED]));
    });
    const { isKnownDrainer } = await freshModule();

    expect(await isKnownDrainer(LISTED)).toBe(true);
    const afterLoad = calls;
    vi.setSystemTime(Date.now() + 60 * 60 * 1000); // an hour later
    expect(await isKnownDrainer(LISTED)).toBe(true);
    expect(calls).toBe(afterLoad); // served from the loaded set
  });
});

describe('drainers — the source must be the MAINTAINED one, and cite its version', () => {
  /**
   * ⚠️ THE DEFECT THIS GUARDS. The list used to be read from
   * blacklist/address.json, which has two commits in its entire history and has
   * been frozen since 2024-02-28, while the repo is pushed daily to
   * blacklist/all.json. Every `drainer_blacklist: "ok"` meant "not in a list that
   * stopped being updated two and a half years ago" — a check that ran, reported
   * cleanly, and was measuring a fossil.
   *
   * The two shapes differ, and the failure is SILENT in the dangerous direction:
   * the old parse against the new file returns [] and the check simply goes dark
   * while still answering `false` to every lookup.
   */
  it('parses the object-shaped list and does NOT accept the frozen array shape', async () => {
    let served: unknown = null;
    vi.stubGlobal('fetch', async (url: string) => {
      if (isVersionLookup(String(url))) return fail();
      if (String(url).includes('scamsniffer')) return ok(served);
      return ok(darklist([]));
    });

    served = scamsniffer([LISTED]);
    const live = await freshModule();
    expect(await live.isKnownDrainer(LISTED)).toBe(true);

    // The frozen file's shape is a bare array. If someone points the URL back at
    // it, or the upstream shape changes underneath us, the list must not load —
    // a dark check that says it is dark beats one that silently answers `false`.
    served = [LISTED];
    const stale = await freshModule();
    expect(await stale.isKnownDrainer(LISTED)).toBe(false);
    expect(stale.drainerListLoaded()).toBe(false);
  });

  /**
   * ⚠️ THIS ASSERTS THE URL, because the shape test above does NOT catch a
   * revert. Both paths live under the same repo, so a fixture keyed on
   * "scamsniffer" serves the object shape whichever file is requested — I
   * pointed the module back at the frozen file and all the behavioural tests
   * still passed. The frozen path is not distinguishable by behaviour in a test
   * that mocks the network; it is only distinguishable by NAME.
   */
  it('points at the maintained path, not the file frozen in 2024', async () => {
    const src = readFileSync(new URL('../src/risk/drainers.ts', import.meta.url), 'utf8');
    const urls = [...src.matchAll(/url: '([^']+)'/g)].map((m) => m[1]);
    const scamsniffer = urls.filter((u) => u.includes('scamsniffer/scam-database'));
    expect(scamsniffer.length).toBe(1);
    expect(scamsniffer[0]).toContain('blacklist/all.json');
    expect(scamsniffer[0]).not.toContain('blacklist/address.json');
  });

  it('records the commit the list was read at, so the answer is citable', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (isVersionLookup(String(url)))
        return ok([{ sha: 'a768368ec0c11598095923ad7c614e7124803abe', commit: { committer: { date: '2026-09-03T10:38:54Z' } } }]);
      return ok(String(url).includes('scamsniffer') ? scamsniffer([LISTED]) : darklist([]));
    });
    const { isKnownDrainer, drainerSourceVersions } = await freshModule();
    await isKnownDrainer(LISTED);
    const v = drainerSourceVersions()['blacklist/all.json'];
    expect(v?.sha).toBe('a768368ec0c11598095923ad7c614e7124803abe');
    expect(v?.date).toBe('2026-09-03T10:38:54Z');
  });

  it('still loads when the version lookup fails, reporting null rather than nothing', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (isVersionLookup(String(url))) return fail();
      return ok(String(url).includes('scamsniffer') ? scamsniffer([LISTED]) : darklist([]));
    });
    const { isKnownDrainer, drainerListLoaded, drainerSourceVersions } = await freshModule();
    expect(await isKnownDrainer(LISTED)).toBe(true);
    expect(drainerListLoaded()).toBe(true);
    expect(drainerSourceVersions()['blacklist/all.json']).toBeNull();
  });
});
