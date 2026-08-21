import type { Address } from 'viem';
import { DAY, NEGATIVE_TTL, TtlCache } from '../cache.js';

const cache = new TtlCache<boolean | null>(5_000, DAY);
const PAGE_CAP = 1_000;

/**
 * Has `sender` ever transacted with `counterparty` before this block?
 * Primary source: Blockscout's public Base API (keyless). Fallback: Etherscan
 * v2 when a key is configured (note: Base account endpoints need a paid
 * Etherscan tier; the call degrades silently on a free key).
 * Returns:
 *   true  → verifiably the first interaction
 *   false → prior interaction found
 *   null  → cannot be determined (history truncated or APIs unreachable) — no flag.
 */
export async function isFirstInteraction(
  sender: Address,
  counterparty: Address,
  beforeBlock: bigint,
): Promise<boolean | null> {
  const cacheKey = `${sender.toLowerCase()}:${counterparty.toLowerCase()}:${beforeBlock}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const history =
    (await fetchTxList(blockscoutUrl(sender, beforeBlock))) ??
    (await fetchEtherscan(sender, beforeBlock));

  let verdict: boolean | null = null;
  if (history !== null) {
    if (history.length >= PAGE_CAP) {
      // History truncated at the page cap: cannot honestly assert "first time".
      verdict = null;
    } else {
      const target = counterparty.toLowerCase();
      verdict = !history.some((tx) => tx.to?.toLowerCase() === target);
    }
  }
  // A null verdict means the lookup failed or the history was truncated, not
  // that the answer is null. Caching it for a day would keep answering from a
  // transient outage long after the source recovered.
  cache.set(cacheKey, verdict, verdict === null ? NEGATIVE_TTL : DAY);
  return verdict;
}

interface TxEntry {
  to?: string;
}

function blockscoutUrl(sender: Address, beforeBlock: bigint): string {
  return (
    `https://base.blockscout.com/api?module=account&action=txlist&address=${sender}` +
    `&startblock=0&endblock=${(beforeBlock - 1n).toString()}&page=1&offset=${PAGE_CAP}&sort=asc`
  );
}

async function fetchTxList(url: string): Promise<TxEntry[] | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { status?: string; message?: string; result?: TxEntry[] | string };
    if (Array.isArray(body.result)) return body.result;
    // "No transactions found" is a real answer: empty history.
    if (body.status === '0' && typeof body.message === 'string' && /no transactions/i.test(body.message)) {
      return [];
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchEtherscan(sender: Address, beforeBlock: bigint): Promise<TxEntry[] | null> {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) return null;
  const url =
    `https://api.etherscan.io/v2/api?chainid=8453&module=account&action=txlist&address=${sender}` +
    `&startblock=0&endblock=${(beforeBlock - 1n).toString()}&page=1&offset=${PAGE_CAP}&sort=asc&apikey=${key}`;
  return fetchTxList(url);
}
