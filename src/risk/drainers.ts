import { HOUR } from '../cache.js';

/**
 * Public scam/drainer address lists, fetched at runtime and merged:
 *  - ScamSniffer scam-database (GPL-3.0 — consumed at runtime, deliberately
 *    NOT bundled or redistributed with this codebase)
 *  - MyEtherWallet ethereum-lists darklist (MIT)
 * Both are EVM-wide rather than Base-scoped, which is correct for drainers.
 */
const SOURCES = [
  {
    /**
     * ⚠️ THIS USED TO POINT AT blacklist/address.json, WHICH HAS BEEN FROZEN
     * SINCE 2024-02-28.
     *
     * That path has two commits in its entire history, the most recent
     * 2024-02-28. Meanwhile the repository is pushed daily and those pushes
     * touch blacklist/all.json. So every `drainer_blacklist: "ok"` we emitted
     * meant "not in a list that stopped being updated two and a half years
     * ago" — a check that ran, reported cleanly, and was measuring a fossil.
     *
     * Verified before switching, because the shapes differ and a wrong parse
     * fails SILENTLY to an empty list here: all.json is an OBJECT with keys
     * `address` (4,607 entries), `domains` and `combined` — not a top-level
     * array. The old parse would have returned [] against it.
     *
     * Coverage checked rather than assumed: the new address list is a strict
     * SUPERSET of the old one — 0 of the 2,530 old entries missing, 2,077
     * gained. All already lowercase.
     */
    url: 'https://raw.githubusercontent.com/scamsniffer/scam-database/main/blacklist/all.json',
    versionPath: 'blacklist/all.json',
    versionRepo: 'scamsniffer/scam-database',
    /**
     * ⚠️ THE PUBLIC EDITION IS LAGGED BY SEVEN DAYS, BY THE VENDOR'S DESIGN, AND
     * POINTING AT THE MAINTAINED FILE DOES NOT CLOSE THAT.
     *
     * Their README, read 2026-09-04: "7-Day Delay: The open-source data is
     * provided with a 7-day delay to balance between offering free resources and
     * protecting our real-time data's integrity." Their real-time API is $999/mo.
     *
     * So the honest claim after every fix we have made is "not present in a
     * blacklist whose public edition trails real-time by seven days" — not "not a
     * known drainer". It matters more here than almost anywhere else because THE
     * VALUE OF A DRAINER CHECK IS CONCENTRATED IN ITS NEWEST ROWS: an address
     * flagged five days ago is, by construction, invisible to us, and that is
     * exactly the population a caller is asking about.
     *
     * This is not a bug to fix, it is a boundary to disclose. Carried on the
     * claim for the same reason gas_price_basis is carried on the gas figure.
     */
    lag: { days: 7, stated_by: 'vendor README', read_at: '2026-09-04' },
    parse: (raw: unknown): string[] => {
      const addrs = (raw as { address?: unknown } | null)?.address;
      return Array.isArray(addrs) ? addrs.filter((a): a is string => typeof a === 'string') : [];
    },
  },
  {
    url: 'https://raw.githubusercontent.com/MyEtherWallet/ethereum-lists/master/src/addresses/addresses-darklist.json',
    // No lag policy is stated by this source. UNKNOWN rather than none — absence
    // of a published delay is not evidence of real-time data.
    lag: null,
    parse: (raw: unknown): string[] =>
      Array.isArray(raw)
        ? raw
            .map((e) => (e && typeof e === 'object' ? (e as { address?: unknown }).address : null))
            .filter((a): a is string => typeof a === 'string')
        : [],
  },
];

const REFRESH_MS = 12 * HOUR;
/**
 * How long to wait before retrying after a refresh that produced nothing.
 * Short on purpose: a blacklist that failed to load is a DARK SAFETY CHECK, and
 * sitting on that for the full refresh interval because the sources blipped once
 * is the expensive direction of this trade.
 */
const FAILED_RETRY_MS = 60_000;

let drainerSet: Set<string> = new Set();
/**
 * When the next refresh may be attempted. Set from the OUTCOME, not from the
 * attempt: a success buys the full interval, a failure buys a minute. Stamping
 * this on every attempt regardless of outcome meant one total failure suppressed
 * retries for twelve hours while the check stayed dark.
 */
let nextAttemptAt = 0;
/**
 * When the list was last actually REBUILT from its sources, as opposed to when a
 * refresh was last attempted. Kept separate because a refresh that fails leaves
 * the previous set in place and still answering lookups — so only this timestamp
 * can tell a fresh list from a stale one that happens to be loaded.
 */
let lastSuccessfulRefresh = 0;
let refreshing: Promise<void> | null = null;

/**
 * The commit each source was at when we last read it.
 *
 * ⚠️ WHY A TIMESTAMP WAS NOT ENOUGH. `drainerListAgeMs` reports when WE last
 * fetched, which is a fact about our scheduler and not about the data. A fresh
 * fetch of a file frozen in 2024 reports as perfectly fresh — that is exactly
 * how the stale source survived for months. The source's own commit is the only
 * thing that distinguishes "current" from "recently downloaded".
 *
 * It also makes the claim CITABLE: "not present in scamsniffer/scam-database
 * blacklist/all.json at <sha>" can be re-checked by anyone, at any later date,
 * against the same bytes. "Not on the drainer list" cannot.
 *
 * Best-effort and never blocking: if the commit lookup fails the list still
 * loads and the version reads null, which is honest rather than absent.
 */
const sourceVersions = new Map<string, { sha: string; date: string } | null>();

/**
 * How many sources answered on the last refresh, out of how many were tried.
 *
 * ⚠️ WHY A COUNT AND NOT A BOOLEAN. refresh() merges with Promise.allSettled and
 * skips rejected sources silently, and the loaded/stale signals both derive from
 * the MERGED set — which stays non-empty while any ONE source answers. So if
 * ScamSniffer started 404ing, MyEtherWallet alone would keep the set populated
 * and the check would keep reporting `ok` with roughly half its coverage and no
 * signal anywhere.
 *
 * That is the same defect as the fossil we just removed, in its other form: the
 * frozen file was a source that was LIVE BUT STALE; this is a source that is
 * ABSENT BUT COVERED FOR. Both let a degraded check answer clean.
 */
let lastRefreshSources = { ok: 0, tried: 0 };

/** Sources that answered on the last successful refresh, and how many were tried. */
export function drainerSourceHealth(): { ok: number; tried: number } {
  return { ...lastRefreshSources };
}

async function fetchSourceVersion(repo: string, path: string): Promise<{ sha: string; date: string } | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/commits?path=${encodeURIComponent(path)}&per_page=1`,
      { signal: AbortSignal.timeout(8_000), headers: { accept: 'application/vnd.github+json' } },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as Array<{ sha?: unknown; commit?: { committer?: { date?: unknown } } }>;
    const top = Array.isArray(body) ? body[0] : undefined;
    const sha = typeof top?.sha === 'string' ? top.sha : null;
    const date = typeof top?.commit?.committer?.date === 'string' ? top.commit.committer.date : null;
    return sha && date ? { sha, date } : null;
  } catch {
    return null;
  }
}

/**
 * What each drainer source was at when last read: commit sha and its date, or
 * null when the lookup failed. Callers should report this beside any
 * drainer_blacklist result so the answer cites the version it was measured against.
 */
export function drainerSourceVersions(): Record<string, { sha: string; date: string } | null> {
  return Object.fromEntries(sourceVersions);
}

/**
 * What each source says about its own freshness, so a `drainer_blacklist` result
 * can be reported with the lag attached rather than as a present-tense fact.
 *
 * `null` means the source publishes no lag policy — UNKNOWN, not zero.
 */
export function drainerSourceLag(): Record<string, { days: number; stated_by: string; read_at: string } | null> {
  return Object.fromEntries(
    SOURCES.map((s) => [
      (s as { versionPath?: string }).versionPath ?? s.url,
      (s as { lag?: { days: number; stated_by: string; read_at: string } | null }).lag ?? null,
    ]),
  );
}

async function refresh(): Promise<void> {
  try {
    const results = await Promise.allSettled(
      SOURCES.map(async (s) => {
        const res = await fetch(s.url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`${s.url}: ${res.status}`);
        const parsed = s.parse((await res.json()) as unknown);
        const repo = (s as { versionRepo?: string }).versionRepo;
        const path = (s as { versionPath?: string }).versionPath;
        if (repo && path) sourceVersions.set(path, await fetchSourceVersion(repo, path));
        return parsed;
      }),
    );
    const merged = new Set<string>();
    let okCount = 0;
    for (const r of results) {
      if (r.status === 'fulfilled') {
        okCount++;
        for (const a of r.value) merged.add(a.toLowerCase());
      }
    }
    // Keep the previous set if every source failed; a stale list beats an empty one.
    if (merged.size > 0) {
      drainerSet = merged;
      lastRefreshSources = { ok: okCount, tried: SOURCES.length };
      lastSuccessfulRefresh = Date.now();
      nextAttemptAt = Date.now() + REFRESH_MS;
    } else {
      nextAttemptAt = Date.now() + FAILED_RETRY_MS;
    }
  } catch {
    nextAttemptAt = Date.now() + FAILED_RETRY_MS;
  } finally {
    refreshing = null;
  }
}

/**
 * Whether the blacklist is actually loaded.
 *
 * `isKnownDrainer` answers `false` both for "checked, not on the list" and for
 * "the list never loaded", and those mean opposite things to a caller. Callers
 * reporting check coverage must consult this rather than inferring safety from
 * a `false`.
 */
export function drainerListLoaded(): boolean {
  return drainerSet.size > 0;
}

/**
 * How stale the list is, in ms, or null when it has never loaded.
 *
 * A blacklist's whole value is recency, so "loaded" is not enough to report the
 * check as having run properly: a stale set still answers lookups, and answers
 * them wrong for anything added since. Failed refreshes now retry within a
 * minute rather than waiting out the full interval, so a list that is genuinely
 * old means the sources have been failing for a while — which is worth
 * surfacing rather than smoothing over.
 */
export function drainerListAgeMs(): number | null {
  if (lastSuccessfulRefresh === 0) return null;
  return Date.now() - lastSuccessfulRefresh;
}

/** Refresh interval, exported so callers can judge staleness against it. */
export const DRAINER_REFRESH_MS = REFRESH_MS;

/** Membership check against the merged drainer lists. Never throws. */
export async function isKnownDrainer(address: string): Promise<boolean> {
  if (Date.now() >= nextAttemptAt && !refreshing) {
    refreshing = refresh();
  }
  // Anyone who would otherwise answer from an EMPTY list waits for the in-flight
  // load — not only the caller that happened to start it. Previously this await
  // sat inside the `!refreshing` branch, so on a cold start the first request
  // waited and every concurrent one skipped the check and answered `false`.
  if (drainerSet.size === 0 && refreshing) {
    try {
      await refreshing;
    } catch {
      // Sources unreachable at cold start: answer without the list. The caller
      // learns the check did not run from `drainerListLoaded()`, not from this.
    }
  }
  return drainerSet.has(address.toLowerCase());
}
