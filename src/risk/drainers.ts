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
    url: 'https://raw.githubusercontent.com/scamsniffer/scam-database/main/blacklist/address.json',
    parse: (raw: unknown): string[] =>
      Array.isArray(raw) ? raw.filter((a): a is string => typeof a === 'string') : [],
  },
  {
    url: 'https://raw.githubusercontent.com/MyEtherWallet/ethereum-lists/master/src/addresses/addresses-darklist.json',
    parse: (raw: unknown): string[] =>
      Array.isArray(raw)
        ? raw
            .map((e) => (e && typeof e === 'object' ? (e as { address?: unknown }).address : null))
            .filter((a): a is string => typeof a === 'string')
        : [],
  },
];

const REFRESH_MS = 12 * HOUR;

let drainerSet: Set<string> = new Set();
let lastRefresh = 0;
let refreshing: Promise<void> | null = null;

async function refresh(): Promise<void> {
  try {
    const results = await Promise.allSettled(
      SOURCES.map(async (s) => {
        const res = await fetch(s.url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`${s.url}: ${res.status}`);
        return s.parse((await res.json()) as unknown);
      }),
    );
    const merged = new Set<string>();
    for (const r of results) {
      if (r.status === 'fulfilled') for (const a of r.value) merged.add(a.toLowerCase());
    }
    // Keep the previous set if every source failed; a stale list beats an empty one.
    if (merged.size > 0) drainerSet = merged;
  } finally {
    lastRefresh = Date.now();
    refreshing = null;
  }
}

/** Membership check against the merged drainer lists. Never throws. */
export async function isKnownDrainer(address: string): Promise<boolean> {
  if (Date.now() - lastRefresh > REFRESH_MS && !refreshing) {
    refreshing = refresh();
    // The first load must complete before answering (otherwise early requests
    // silently skip the check); later refreshes run in the background.
    if (drainerSet.size === 0) {
      try {
        await refreshing;
      } catch {
        // Unreachable sources at cold start: answer without the list.
      }
    }
  }
  return drainerSet.has(address.toLowerCase());
}
