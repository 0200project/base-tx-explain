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
 * SCOPE, HONESTLY: this is per-process. Behind multiple instances an
 * authorization can still be spent once per instance, so it divides the
 * amplification by the instance count rather than eliminating it. Closing that
 * needs shared state, which is not worth it at this price point — and the
 * unbounded case, one authorization spent thousands of times, is gone either way.
 */

const TTL_MS = 10 * 60 * 1000; // comfortably longer than an authorization's validity window
const MAX_ENTRIES = 1000;

type Entry<T> = { at: number; p: Promise<T> };

const inFlight = new Map<string, Entry<unknown>>();

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
export function onceByAuthorization<T>(key: string | null, work: () => Promise<T>): Promise<T> {
  if (!key) return work(); // unidentifiable: behave exactly as before

  const now = Date.now();
  const existing = inFlight.get(key);
  if (existing && now - existing.at <= TTL_MS) return existing.p as Promise<T>;

  prune(now);
  const p = work();
  inFlight.set(key, { at: now, p: p as Promise<unknown> });

  // A failure leaves the authorization unspent, so it must not be remembered.
  p.catch(() => {
    if (inFlight.get(key)?.p === p) inFlight.delete(key);
  });
  return p;
}

/** Forget one authorization's retained result (used when the decode came back an error). */
export function forgetAuthorization(key: string | null): void {
  if (key) inFlight.delete(key);
}

/** Test seam. */
export function _resetAuthOnce(): void {
  inFlight.clear();
}
