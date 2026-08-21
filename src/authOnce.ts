/**
 * ONE SIGNED AUTHORIZATION BUYS ONE DECODE.
 *
 * THE GAP THIS CLOSES
 *
 * An EIP-3009 authorization is consumed on-chain only when it SETTLES. Our paid
 * path verifies, runs the decode, and settles afterwards, so between verify and
 * settle the nonce is still unused as far as the chain is concerned. The
 * facilitator's verify simulates the transfer against current chain state
 * (`simulateEip3009TransferResult`), which is why a broke wallet cannot mint
 * free calls — but a simulation is a question about the present, and N copies of
 * one authorization arriving together all get the same honest "yes".
 *
 * So N concurrent requests carrying ONE signed authorization each pass verify,
 * each run a full decode, and exactly one settles; the other N-1 revert. The
 * revenue loss is trivial (N x $0.02) and was never the point. The cost is
 * upstream: every one of those decodes spends real RPC calls — trace, receipt,
 * token metadata — so one $0.02 payment buys an unbounded multiple of our most
 * expensive resource. That is a cost-amplification bug, not a revenue bug, and
 * we are the only party positioned to close it: the chain cannot, because
 * nothing is wrong on-chain until settle.
 *
 * WHY THIS DEDUPES INSTEAD OF REJECTING
 *
 * The obvious fix — reject a repeated authorization — breaks the honest case it
 * cannot distinguish from the attack. A client whose response was lost to a
 * dropped connection retries with the same authorization; if the first attempt
 * settled, rejecting the retry takes the money and withholds the decode. That is
 * the one error this service must never make, and it is worse than the leak.
 *
 * Returning the SAME decode to every caller of one authorization is strictly
 * better than either: the honest retry gets what it paid for, and the replay
 * gets nothing it did not already have, because the work is done once. The
 * amplification disappears without any rule that can turn against a customer.
 *
 * Failures are deliberately NOT retained. A decode that errored does not settle
 * (the wrapper cancels settlement on isError), so its authorization is still
 * unspent and a retry must be allowed to really run.
 *
 * ONE AUTHORIZATION IS BOUND TO ONE TRANSACTION
 *
 * Sharing a result across an authorization is only safe while every caller is
 * asking the SAME question. If the key were the authorization alone, a burst
 * carrying one authorization and N DIFFERENT tx_hashes would collapse to one
 * decode and hand N-1 callers the decode of a transaction they never asked
 * about — authoritative JSON, silently about the wrong transaction, which other
 * agents then act on. That is far worse than the cost bug this module exists to
 * fix, and it is also the shape an attacker maximising RPC spend would choose.
 *
 * So the first call binds the authorization to its transaction hash. A later
 * call on that authorization asking about a DIFFERENT hash is refused rather
 * than answered: no decode runs (so no amplification) and no wrong answer is
 * returned. Refusing is safe here in a way that refusing a retry is not — the
 * payer bought one decode and already has it; asking for a second transaction on
 * one authorization is asking for two decodes on one payment.
 *
 * SETTLE FAILED BUT THE DECODE SUCCEEDED — a deliberate decision, not a side
 * effect. The result stays retained, so a repeat of that authorization is served
 * from cache without ever settling. This is the existing serve-on-ambiguity
 * design (a facilitator `success:false` does not prove no money moved), and
 * retaining is the amplification-safe direction: every repeat gets the SAME
 * decode, so the exposure is one decode for one possibly-unpaid authorization,
 * not one per request. Evicting instead would be the revenue-optimistic choice
 * and would reopen the exact amplification this module closes.
 *
 * SCOPE, HONESTLY: this is per-process. Behind multiple instances an
 * authorization can still be spent once per instance, so it divides the
 * amplification by the instance count rather than eliminating it. Closing that
 * needs shared state, which is not worth it at this price point — and the
 * unbounded case, one authorization spent thousands of times, is gone either way.
 */

const TTL_MS = 10 * 60 * 1000; // comfortably longer than an authorization's validity window
const MAX_ENTRIES = 1000;

type Entry = { at: number; arg: string; p: Promise<unknown> };

const inFlight = new Map<string, Entry>();

/**
 * What happened to a call: either we have its result, or the authorization is
 * already committed to a different transaction and this call is refused.
 */
export type Once<T> = { kind: 'result'; value: T } | { kind: 'conflict'; boundTo: string };

/**
 * Identify the authorization behind a call, or null if there isn't one we can
 * read. Null disables deduplication for that call — an unreadable payload must
 * behave exactly as it did before this module existed, never fail closed.
 *
 * The payload lives at `meta` inside the x402 wrapper and at `_meta` at the MCP
 * tool boundary; this runs OUTSIDE the wrapper, so `_meta` is the live one. Both
 * are read because the difference between them has already caused one outage.
 */
export function authKeyOf(ctx: unknown): string | null {
  const c = ctx as { meta?: Record<string, unknown>; _meta?: Record<string, unknown> } | undefined;
  const payload = c?.meta?.['x402/payment'] ?? c?._meta?.['x402/payment'];
  const auth = (payload as { payload?: { authorization?: { nonce?: unknown; from?: unknown } } } | undefined)
    ?.payload?.authorization;
  const nonce = typeof auth?.nonce === 'string' ? auth.nonce : null;
  const from = typeof auth?.from === 'string' ? auth.from : null;
  if (!nonce || !from) return null;
  return `${from.toLowerCase()}:${nonce.toLowerCase()}`;
}

/** Drop expired entries, and the oldest ones if we are over the cap. */
function prune(now: number): void {
  for (const [k, v] of inFlight) if (now - v.at > TTL_MS) inFlight.delete(k);
  if (inFlight.size <= MAX_ENTRIES) return;
  const byAge = [...inFlight].sort((a, b) => a[1].at - b[1].at);
  for (let i = 0; i < byAge.length - MAX_ENTRIES; i++) {
    const entry = byAge[i];
    if (entry) inFlight.delete(entry[0]);
  }
}

/**
 * Run `work` at most once per authorization, handing every other caller of that
 * same authorization the identical result.
 *
 * The lookup and the insert are one synchronous block on purpose: with no await
 * between them, two simultaneous requests cannot both find the map empty.
 */
export async function onceByAuthorization<T>(
  key: string | null,
  arg: string,
  work: () => Promise<T>,
): Promise<Once<T>> {
  if (!key) return { kind: 'result', value: await work() }; // unidentifiable: behave exactly as before

  const now = Date.now();
  const existing = inFlight.get(key);
  if (existing && now - existing.at <= TTL_MS) {
    // Same question: share the one decode. Different question: this
    // authorization is spoken for, and answering would answer the wrong thing.
    if (existing.arg !== arg) return { kind: 'conflict', boundTo: existing.arg };
    return { kind: 'result', value: (await existing.p) as T };
  }

  const p = work();
  inFlight.set(key, { at: now, arg, p: p as Promise<unknown> });
  prune(now); // after the insert, so the cap is the real ceiling and not off by one

  // A failure leaves the authorization unspent, so it must not be remembered.
  p.catch(() => {
    if (inFlight.get(key)?.p === p) inFlight.delete(key);
  });
  return { kind: 'result', value: await p };
}

/** Forget one authorization's retained result (used when the decode came back an error). */
export function forgetAuthorization(key: string | null): void {
  if (key) inFlight.delete(key);
}

/** Test seams. */
export function _resetAuthOnce(): void {
  inFlight.clear();
}
export function _authOnceSize(): number {
  return inFlight.size;
}
