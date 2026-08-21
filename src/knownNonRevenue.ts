/**
 * The single list of money that arrived and is NOT revenue.
 *
 * This exists as its own module because the same list had already been written
 * three times — in the reconciler, in the daily report, and implicitly in
 * whoever was reading /healthz and remembering the context. Three copies of one
 * fact drift, and the one that drifts is always the one somebody external is
 * reading.
 *
 * That is the fifth appearance of a single missing invariant, restated per
 * surface: REVENUE IS BOOKED ONLY FROM A CONFIRMED, LIVE, SETTLED PAYMENT, AND
 * EVERY SURFACE THAT DISPLAYS MONEY MUST DISTINGUISH ATTEMPTED FROM RECEIVED —
 * and now also EARNED from MERELY ARRIVED. The previous four were an
 * unconditional settle booking, payment attempts reading as revenue on the
 * dashboard, Stripe test-mode purchases, and the reconciler asserting unbooked
 * revenue that did not exist. Each was fixed where it appeared. This one is
 * fixed by giving every surface the same source.
 *
 * Listed by transaction hash rather than as a lump sum: a hash survives a
 * re-read, documents its own reason, and cannot silently absorb a future
 * arrival the way a running total can.
 */

export interface KnownNonRevenue {
  /** Base transaction hash, or a marker when the arrival predates our records. */
  tx: string;
  amount_usd: number;
  why: string;
  /**
   * Did the ledger actually BOOK this as a settlement?
   *
   * The distinction is load-bearing and I got it wrong first time. Two
   * different denominators want this list:
   *
   *  - the reconciler compares WALLET RECEIPTS against booked revenue, so it
   *    must exclude EVERY arrival, booked or not;
   *  - `revenue_usd` is the sum of BOOKED settlements, so subtracting an
   *    arrival that was never booked removes money that was never there.
   *
   * Conflating them produced "$0.02 settled, of which $0.04 is not revenue" on
   * a public endpoint — arithmetic nonsense, in the exact place this list was
   * created to make honest.
   */
  booked: boolean;
}

export const KNOWN_NON_REVENUE: KnownNonRevenue[] = [
  {
    // Verified on chain: both wallets show zero outbound transactions, because
    // the value moved by EIP-3009 where the payer signs and the facilitator
    // submits. Budget 4.98 + payout 0.02 = the 5.00 originally funded.
    tx: 'internal-transfer-2026-08-20-selftest',
    amount_usd: 0.02,
    why: 'Internal transfer, budget wallet to payout wallet, during our own first paid-call test. Same company on both sides, net cash effect zero.',
    // Arrived ~70 minutes before the ledger that could have recorded it
    // existed, so it was never booked and must not be subtracted from revenue.
    booked: false,
  },
  {
    // Circadian evaluated the pass and declined to buy, with numbers: 24 hashes
    // in 24 days, roughly $7.30/year at per-call, "the answer is no, with no
    // hedging." They then offered twice, unprompted, to run one paid call as a
    // technical probe of the in-band MCP path, which had never carried a real
    // payment. This is that call. Booking it as revenue would record as our
    // first sale a transaction the payer explicitly said was not one.
    tx: '0x6ce5e3948c9c6b8e0ef8413f3c29623163bb7b58155eda90a67464f3bb119110',
    amount_usd: 0.02,
    why: 'Pre-arranged technical probe by Circadian, who declined to buy. A favour, not a sale.',
    // Settled through the normal path, so the ledger did book it as revenue.
    booked: true,
  },
];

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * Every non-revenue arrival, booked or not. For comparing against WALLET
 * RECEIPTS, which contain all of them regardless of what the ledger recorded.
 */
export function knownNonRevenueTotal(): number {
  return round6(KNOWN_NON_REVENUE.reduce((t, k) => t + k.amount_usd, 0));
}

/**
 * Only the arrivals the ledger actually booked. For subtracting from
 * `revenue_usd`, which contains nothing else.
 */
export function bookedNonRevenueTotal(): number {
  return round6(KNOWN_NON_REVENUE.filter((k) => k.booked).reduce((t, k) => t + k.amount_usd, 0));
}

/**
 * One sentence a stranger can read on a public endpoint without context.
 *
 * /healthz is public and unauthenticated. Someone evaluating this service reads
 * a non-zero revenue figure as "this has a paying customer", and until now
 * nothing on that surface said otherwise. The raw figure stays — money really
 * did settle, and hiding it would be its own dishonesty — but it no longer
 * travels alone.
 */
export function revenueNote(rawRevenueUsd: number, customerRevenueUsd: number): string | null {
  const excluded = bookedNonRevenueTotal();
  if (excluded <= 0 || rawRevenueUsd <= 0) return null;
  return (
    `$${rawRevenueUsd.toFixed(2)} settled on chain, of which $${excluded.toFixed(2)} is not revenue ` +
    '(a pre-arranged technical probe by a party who evaluated this service and declined to buy). ' +
    `Revenue from customers is $${customerRevenueUsd.toFixed(2)}.`
  );
}
