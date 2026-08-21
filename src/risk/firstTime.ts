import type { Address } from 'viem';
import { DAY, NEGATIVE_TTL, TtlCache } from '../cache.js';

/**
 * The outcome of a first-interaction lookup.
 *
 *  - `first`       — verifiably the sender's first transaction with this counterparty.
 *  - `seen`        — a prior interaction was found.
 *  - `unreachable` — every upstream failed. Transient: a retry may get an answer.
 *  - `truncated`   — the sender's history is longer than the single page this method
 *                    reads (PAGE_CAP), so "first time" cannot be honestly asserted.
 *
 * `unreachable` and `truncated` are both "no answer", but they are not the same
 * kind of no. The first is our lookup failing; the second is the method meeting an
 * honest limit, permanently for this sender — a retry reads the same capped page.
 * The distinction also carries information that collapsing them discards: a sender
 * with more than PAGE_CAP transactions is high-activity, for whom "first
 * interaction" is a weak signal in the first place, where the same answer about a
 * days-old wallet would be a strong one.
 */
export type FirstInteractionResult =
  | { kind: 'first' }
  | { kind: 'seen' }
  | { kind: 'unreachable' }
  | { kind: 'truncated' };

const cache = new TtlCache<FirstInteractionResult>(5_000, DAY);
const PAGE_CAP = 1_000;

/**
 * Has `sender` ever transacted with `counterparty` before this block?
 * Primary source: Blockscout's public Base API (keyless). Fallback: Etherscan
 * v2 when a key is configured (note: Base account endpoints need a paid
 * Etherscan tier; the call degrades silently on a free key).
 *
 * Never throws: anything other than `first` means no flag is emitted, and the
 * caller reports which kind of no-answer it was.
 */
export async function isFirstInteraction(
  sender: Address,
  counterparty: Address,
  beforeBlock: bigint,
): Promise<FirstInteractionResult> {
  const cacheKey = `${sender.toLowerCase()}:${counterparty.toLowerCase()}:${beforeBlock}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const history =
    (await fetchTxList(blockscoutUrl(sender, beforeBlock))) ??
    (await fetchEtherscan(sender, beforeBlock));

  let verdict: FirstInteractionResult;
  if (history === null) {
    verdict = { kind: 'unreachable' };
  } else if (history.length >= PAGE_CAP) {
    // History truncated at the page cap: cannot honestly assert "first time".
    verdict = { kind: 'truncated' };
  } else {
    const target = counterparty.toLowerCase();
    verdict = history.some((tx) => tx.to?.toLowerCase() === target) ? { kind: 'seen' } : { kind: 'first' };
  }
  // Only `unreachable` is transient. Caching it for a day would keep answering
  // from a momentary outage long after the source recovered. Everything else,
  // `truncated` included, is fixed for this key: the history before an already
  // mined block does not change, so re-reading it would return the same page.
  cache.set(cacheKey, verdict, verdict.kind === 'unreachable' ? NEGATIVE_TTL : DAY);
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
