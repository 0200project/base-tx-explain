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

// --- Outbound request discipline for the one flaky upstream this check rides on ---
//
// Blockscout's public keyless API is the only working source of Base account
// history (Etherscan's Base account endpoints need a paid tier, so the fallback
// below is inert unless ETHERSCAN_API_KEY is a paid key). Measured behaviour on
// 2026-08-30: it rate-limits us (HTTP 429) the moment we burst, and the 429
// window is CORRELATED — retrying inside it keeps failing until the window
// resets. It also returns transient 500s. Left unmanaged this made this check
// the only one dark ~half the time, because a single decode fires up to CHECK_CAP
// concurrent lookups and trips the limit on itself.
//
// Primary control: never burst. A timer-free concurrency cap holds in-flight
// requests to MAX_CONCURRENT, so the 3-counterparty case no longer fires three
// at once and the naturally-sequential completion of queued requests spaces them
// out on its own — without a clock, so it composes with fake timers in tests and
// never sleeps on the success path. Secondary control: retry, only for transient
// failures (429 / 5xx / network / timeout), bounded by attempt count AND a
// wall-clock deadline so a struggling upstream can never stall a decode. Measured
// failures return fast (~0.1-1s), so a couple of spaced retries stay inside the
// decode's latency budget. A real answer (even an empty history) is never
// retried; a permanent client error (4xx other than 429) is never retried.
const MAX_CONCURRENT = 2;
const PER_ATTEMPT_TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 300;
const OVERALL_DEADLINE_MS = 8_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A minimal concurrency gate: at most MAX_CONCURRENT calls run at once; the rest
// wait for a slot. No timers, so a request under the cap proceeds immediately.
// Cache hits never enter here, so only genuine upstream misses pay any wait.
let active = 0;
const waiters: Array<() => void> = [];

async function schedule<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    const next = waiters.shift();
    if (next) next();
  }
}

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
    (await fetchTxListResilient(blockscoutUrl(sender, beforeBlock))) ??
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
  // An optional Blockscout API key lifts the per-key rate limit. It is not
  // required — the endpoint is keyless — but when BLOCKSCOUT_API_KEY is set the
  // burst ceiling that makes this check flaky rises with it. No key: same call,
  // subject to the shared public limit the scheduling above is built to respect.
  const key = process.env.BLOCKSCOUT_API_KEY;
  return (
    `https://base.blockscout.com/api?module=account&action=txlist&address=${sender}` +
    `&startblock=0&endblock=${(beforeBlock - 1n).toString()}&page=1&offset=${PAGE_CAP}&sort=asc` +
    (key ? `&apikey=${key}` : '')
  );
}

/**
 * The outcome of one HTTP attempt. `transient` marks a failure a retry might
 * recover (429, 5xx, network error, timeout); everything else — a usable array,
 * an honest empty history, or a permanent client error — is final and never
 * retried.
 */
interface Attempt {
  result: TxEntry[] | null;
  transient: boolean;
}

async function attemptTxList(url: string): Promise<Attempt> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PER_ATTEMPT_TIMEOUT_MS) });
    if (!res.ok) {
      // 429 (rate limited) and 5xx (server wobble) may clear on a spaced retry;
      // any other non-2xx is a permanent no from this source.
      const transient = res.status === 429 || res.status >= 500;
      return { result: null, transient };
    }
    const body = (await res.json()) as { status?: string; message?: string; result?: TxEntry[] | string };
    if (Array.isArray(body.result)) return { result: body.result, transient: false };
    // "No transactions found" is a real answer: empty history.
    if (body.status === '0' && typeof body.message === 'string' && /no transactions/i.test(body.message)) {
      return { result: [], transient: false };
    }
    // A 200 whose shape we do not recognise: treat as a transient upstream hiccup
    // rather than a confident "no answer", since a retry has occasionally returned
    // a well-formed body.
    return { result: null, transient: true };
  } catch {
    // AbortSignal timeout or a network error — both worth one more spaced try.
    return { result: null, transient: true };
  }
}

/**
 * Blockscout with burst discipline and bounded retries. Returns the transaction
 * list, [] for an empty history, or null when every attempt failed (the caller
 * reports that as `unreachable`). Never throws.
 */
async function fetchTxListResilient(url: string): Promise<TxEntry[] | null> {
  const deadline = Date.now() + OVERALL_DEADLINE_MS;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { result, transient } = await schedule(() => attemptTxList(url));
    if (!transient) return result; // a definite answer: array, empty, or permanent no
    if (attempt >= MAX_ATTEMPTS || Date.now() >= deadline) break;
    // Spaced backoff with jitter so concurrent lookups do not retry in lockstep.
    const backoff = BACKOFF_BASE_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);
    if (Date.now() + backoff >= deadline) break;
    await sleep(backoff);
  }
  return null;
}

async function fetchEtherscan(sender: Address, beforeBlock: bigint): Promise<TxEntry[] | null> {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) return null;
  const url =
    `https://api.etherscan.io/v2/api?chainid=8453&module=account&action=txlist&address=${sender}` +
    `&startblock=0&endblock=${(beforeBlock - 1n).toString()}&page=1&offset=${PAGE_CAP}&sort=asc&apikey=${key}`;
  // The keyed fallback runs through the same burst discipline and retry policy.
  return fetchTxListResilient(url);
}
