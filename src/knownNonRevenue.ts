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
    // An external evaluator assessed the pass and declined to buy, with numbers:
    // in 24 days, roughly $7.30/year at per-call, "the answer is no, with no
    // hedging." They then offered twice, unprompted, to run one paid call as a
    // technical probe of the in-band MCP path, which had never carried a real
    // payment. This is that call. Booking it as revenue would record as our
    // first sale a transaction the payer explicitly said was not one.
    tx: '0x6ce5e3948c9c6b8e0ef8413f3c29623163bb7b58155eda90a67464f3bb119110',
    amount_usd: 0.02,
    why: 'Pre-arranged technical probe by an external evaluator, who declined to buy. A favour, not a sale.',
    // Settled through the normal path, so the ledger did book it as revenue.
    booked: true,
  },
  {
    // The founder proving the x402 rail end to end, 2026-08-26T05:53:55Z. Payer
    // 0x2E31f337...D06FC7 is the company SPEND wallet; the destination is the
    // company payout wallet. Verified three ways independently: Platform watched
    // the signature happen and confirmed the settlement in the ledger within
    // seconds; Finance traced the transfer via eth_getLogs and matched the
    // spend wallet's balance dropping by exactly $0.02; and the payout wallet
    // rose $0.04 -> $0.06. Money moving between two pockets of the same company.
    //
    // Stripe has SELF_PURCHASE_EMAIL to label the founder's own card purchases
    // at the moment they happen; x402 has no equivalent guard, so this landed
    // in `unattributed` — the bucket that means "awaiting a human." It was not
    // awaiting anyone: three parties knew whose it was within the minute. This
    // entry is that human ruling, written down.
    tx: '0x96c6a01854d9c412145ae2f2d9a7dcd46f252d24514df931fa955d79bbf05c32',
    amount_usd: 0.02,
    why: "Founder's own x402 self-test proving the rail, spend wallet to payout wallet. Company money on both sides, not a sale.",
    // Settled through the normal path, so the ledger booked it.
    booked: true,
  },
  {
    // The founder proving the never-run $9 buy_pass composition end to end,
    // 2026-08-29T22:06:33Z. Payer 0x2E31f337...D06FC7 is the company SPEND
    // wallet again; destination is the payout wallet. This one exercised the
    // path no prior test had: verify -> settle -> mint -> deliver -> and the
    // delivered token authorized a real decode (Platform confirmed the token
    // returned live output within the minute). Payout wallet rose $0.08 -> $9.08.
    // Same company on both sides, so it is a cost of proving the rail, not a
    // sale — the human ruling, written down, exactly like the $0.02 above.
    //
    // Booked the same day the FIRST REAL customer settlement was promoted
    // (an external payer, $0.02, tx 0x325557e1...). Kept scrupulously apart: that $0.02
    // is customer revenue; this $9.00 is ours. Conflating them would have put
    // the founder's own money on the board as a sale, which is the precise
    // failure this list exists to prevent.
    tx: '0x5606d4f24a2846ed8144a35abf724921b0aa3147af9ceeabb00a89e383fd9ba8',
    amount_usd: 9,
    why: "Founder's own x402 self-test proving the $9 buy_pass mint-and-deliver path, spend wallet to payout wallet. Company money on both sides, not a sale.",
    // Settled through the normal path, so the ledger booked it.
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
export function revenueNote(split: {
  /** lifetime.revenue_usd — everything booked, every rail. */
  rawRevenueUsd: number;
  /** Only what a human has promoted to being from a customer. */
  customerRevenueUsd: number;
  /** Our own purchases, labelled at the moment they settled. */
  selfUsd: number;
  /** Written off with a stated reason. */
  knownNonRevenueUsd: number;
  /** Money arrived, nobody has said whose it is. */
  unattributedUsd: number;
}): string | null {
  const { rawRevenueUsd, customerRevenueUsd, selfUsd, knownNonRevenueUsd, unattributedUsd } = split;
  if (rawRevenueUsd <= 0) return null;

  // ACCOUNT FOR EVERY DOLLAR, not just the written-off ones. The old sentence
  // named only the KNOWN_NON_REVENUE portion, so on 2026-08-23 it read
  // "$9.02 settled on chain, of which $0.02 is not revenue" and then, two
  // clauses later, "Revenue from customers is $0.00." Both numbers were right
  // and the sentence contradicted itself: the $9.00 self-purchase was excluded
  // from revenue but not from the exclusions. A reader could only conclude that
  // $9 of real revenue had gone missing somewhere in the punctuation.
  const parts: string[] = [];
  if (knownNonRevenueUsd > 0) {
    parts.push(
      // Was "(a pre-arranged technical probe...)" — accurate while the list
      // held one booked entry, wrong the moment it held two for different
      // reasons. The per-entry reasons live in KNOWN_NON_REVENUE; this sentence
      // only claims what is true of all of them.
      `$${knownNonRevenueUsd.toFixed(2)} written off as known non-revenue, each with its reason recorded`,
    );
  }
  if (selfUsd > 0) {
    parts.push(`$${selfUsd.toFixed(2)} paid by us to prove the rail works, which is a cost and not a sale`);
  }
  if (unattributedUsd > 0) {
    parts.push(`$${unattributedUsd.toFixed(2)} arrived but not yet attributed to anyone`);
  }
  if (parts.length === 0) return null;

  // NOT "on chain". That was true while x402 was the only rail; the first live
  // card sale made it false, and a figure that misstates WHERE the money is
  // sends anyone checking it to the wrong ledger.
  return (
    `$${rawRevenueUsd.toFixed(2)} has settled across all rails, of which ` +
    `${parts.join('; ')}. ` +
    `Revenue from customers is $${customerRevenueUsd.toFixed(2)}.`
  );
}

/**
 * Is this settlement one of the arrivals we have already written off?
 *
 * Membership of this list IS an attribution decision — a human looked at the
 * arrival, reached a conclusion, and wrote down why. It simply predates the
 * mechanism that now records such decisions.
 *
 * That matters because `unattributed` means AWAITING A HUMAN, and these are not
 * awaiting anyone. Reporting them there put two of our own statements on the
 * same public endpoint in contradiction: `known_non_revenue_usd: 0.02` naming
 * exactly who paid it and why, beside `unattributed_revenue_usd: 0.02` saying
 * nobody has established whose it is.
 *
 * It also destroys the bucket's usefulness. `unattributed` is only a signal if
 * zero is its resting state; with a permanent floor a real $9 sale reads 9.02,
 * which nobody can distinguish at a glance from the number already sitting
 * there. A bucket that is always lit is one nobody looks at twice — the same
 * reason an alarm that cannot be switched off gets ignored on the day it
 * matters.
 *
 * Checked BEFORE the promotion set on purpose: a written record with a stated
 * reason should outrank a click, so a mistaken promotion cannot turn a
 * documented favour into revenue.
 */
export function isKnownNonRevenue(ref: string | undefined): boolean {
  if (!ref) return false;
  const needle = ref.toLowerCase();
  return KNOWN_NON_REVENUE.some((k) => k.tx.toLowerCase() === needle);
}

/**
 * The written reason this arrival was ruled out, or null.
 *
 * Exposed so a refusal can TELL the operator why rather than just saying no.
 * A guard that blocks without explaining gets worked around; one that quotes
 * the paragraph somebody wrote gets understood.
 */
export function knownNonRevenueReason(ref: string | undefined): string | null {
  if (!ref) return null;
  const needle = ref.toLowerCase();
  return KNOWN_NON_REVENUE.find((k) => k.tx.toLowerCase() === needle)?.why ?? null;
}
