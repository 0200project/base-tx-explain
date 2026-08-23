import { knownNonRevenueTotal } from './knownNonRevenue.js';
import type { TreasurySnapshot } from './treasury.js';

/**
 * Booked revenue vs. the money actually on chain.
 *
 * The ledger books revenue only on a confirmed settlement (`settledOk` in
 * index.ts), while the payment path deliberately SERVES the call whenever the
 * settlement outcome is ambiguous — denying a real payer is worse than
 * under-reporting. That tradeoff is correct and is not something to fix, but it
 * means booked revenue can legitimately drift below what the wallet received,
 * and until now that drift was invisible: the dashboard showed a balance and a
 * revenue counter side by side and never compared them.
 *
 * This compares them and names the difference. It is a read-only report — it
 * never rewrites the ledger, never books revenue the settlement hooks declined
 * to book, and has no bearing on whether any call is served.
 *
 * LIMIT worth knowing: the wallet balance is a BALANCE, not a cumulative
 * receipts total. Every dollar swept out of the payout wallet looks exactly
 * like a dollar that never arrived. There are zero outbound transfers today, so
 * balance == receipts; the moment that stops being true, set
 * TREASURY_WITHDRAWN_USD to the running total swept so the delta stays honest.
 */

export type ReconcileStatus = 'reconciled' | 'unbooked_revenue' | 'overbooked' | 'unknown';

export interface ReconcileInput {
  treasury: TreasurySnapshot;
  /**
   * lifetime.revenue_usd — the sum of confirmed `settled` events across EVERY
   * rail. Reported, never compared: see the field below.
   */
  booked_usd: number;
  /**
   * Booked customer money that actually moved on chain — the ONLY figure that
   * may be compared against the payout wallet, because the wallet only ever
   * sees that rail. Supplied by `onChainBookedFromCustomersUsd()`, which
   * explains why comparing the cross-rail total produced a phantom drain.
   */
  on_chain_booked_from_customers_usd: number;
  /**
   * lifetime.settlements — count of confirmed settlements across every rail.
   * Reported, never compared against `paid_calls`: see `on_chain_settlements`.
   */
  settlements: number;
  /**
   * Confirmed settlements that moved on chain. The only count that may be
   * subtracted from `paid_calls`, which is itself x402-only.
   */
  on_chain_settlements: number;
  /** lifetime.paid_calls — calls served with a payment attached and verified. */
  paid_calls: number;
  /** Per-call price, used only to size the unbooked-call notional. */
  price_usd: number;
  /** Operator-declared cumulative sweeps out of the payout wallet. */
  withdrawn_usd: number;
}

export interface Reconciliation {
  status: ReconcileStatus;
  /** Revenue the ledger has booked. */
  booked_usd: number;
  /** Current on-chain USDC balance, or null when the read failed. */
  wallet_usd: number | null;
  /** Declared sweeps, added back so a withdrawal is not read as a shortfall. */
  withdrawn_usd: number;
  /** wallet + withdrawn = everything the wallet has ever received. */
  received_usd: number | null;
  /** Arrivals we know are not revenue: our own transfers, logged favours. */
  known_non_revenue_usd: number;
  /** received minus known non-revenue. This is what customers actually sent. */
  received_from_customers_usd: number | null;
  /**
   * booked minus the non-revenue the ledger BOOKED. The counterpart to
   * `received_from_customers_usd`, and the only figure it may be compared
   * against — see the note beside the delta calculation.
   */
  booked_from_customers_usd: number;
  /**
   * received_from_customers - booked. This drives `status`.
   *
   * The raw received-minus-booked is deliberately NOT the signal: it counts our
   * own money as though a customer had sent it.
   */
  delta_usd: number | null;
  /** Calls served against a payment that never produced a booked settlement. */
  unbooked_paid_calls: number;
  /**
   * What those calls WOULD have been worth at the per-call price.
   *
   * Notional only: not owed, not received, and not an explanation of any delta.
   * All four such calls to date moved no money at all, and the one real arrival
   * predates every one of them. Two unrelated facts sitting adjacent in one
   * block is precisely how the original tidy-but-wrong story got told.
   */
  unbooked_notional_usd: number;
  wallet: string;
  read_at: string | null;
  /** One plain sentence, safe to print straight to a terminal or a dashboard. */
  note: string;
}

/** Half a cent: far below one $0.02 sale, and above float drift on summed cents. */
const EPSILON_USD = 0.005;

function money(n: number): number {
  return Number(n.toFixed(6));
}

function safe(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/** Cumulative USDC swept out of the payout wallet, declared by the operator. */
export function declaredWithdrawn(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseFloat(env.TREASURY_WITHDRAWN_USD ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * Pure and total: any bad input degrades to `unknown` rather than throwing.
 * This runs inside the /stats handler, where an exception would blank the one
 * page the founder uses to see whether the funnel converts.
 */
export function reconcile(input: ReconcileInput): Reconciliation {
  const booked = money(safe(input.booked_usd));
  const withdrawn = money(safe(input.withdrawn_usd));
  const paidCalls = Math.max(0, Math.trunc(safe(input.paid_calls)));
  // ON-CHAIN settlements only. `paid_calls` counts calls that arrived carrying
  // an x402 payload — a single rail — so subtracting settlements from EVERY rail
  // makes each card sale silently cancel one unbooked x402 call. Same cross-rail
  // error as the delta above, one field over, and this one fails in the
  // flattering direction: a healthy card business would drive this counter to
  // zero and hide a genuine x402 leak completely. Found while investigating what
  // the 8 unbooked calls actually were; the honest count was 9.
  const settlements = Math.max(0, Math.trunc(safe(input.on_chain_settlements)));
  const price = safe(input.price_usd);
  const unbookedCalls = Math.max(0, paidCalls - settlements);
  const unbookedNotional = money(unbookedCalls * price);

  const wallet = input.treasury?.wallet ?? '';
  const readAt = input.treasury?.read_at ?? null;
  const balance = input.treasury?.usdc_balance;

  const base = {
    booked_usd: booked,
    withdrawn_usd: withdrawn,
    unbooked_paid_calls: unbookedCalls,
    unbooked_notional_usd: unbookedNotional,
    wallet,
    read_at: readAt,
  };

  if (typeof balance !== 'number' || !Number.isFinite(balance)) {
    return {
      ...base,
      status: 'unknown',
      wallet_usd: null,
      received_usd: null,
      known_non_revenue_usd: knownNonRevenueTotal(),
      received_from_customers_usd: null,
      booked_from_customers_usd: money(safe(input.on_chain_booked_from_customers_usd)),
      delta_usd: null,
      note:
        'Cannot reconcile: the payout wallet balance could not be read, so booked revenue of ' +
        usd(booked) +
        ' is unverified against the chain.',
    };
  }

  const received = money(balance + withdrawn);
  const knownNonRevenue = knownNonRevenueTotal();
  const receivedFromCustomers = money(received - knownNonRevenue);
  // BOTH SIDES MUST EXCLUDE THE SAME THING. The received side has every
  // non-revenue arrival removed; the booked side must have the ones the ledger
  // actually booked removed too, or the comparison is asymmetric and the
  // difference is the exclusion itself rather than anything about the money.
  //
  // Getting this wrong is not a cosmetic off-by-one: with $0.02 booked for a
  // favour that was also stripped from receipts, the reconciler read
  // `overbooked` and printed "USDC was swept out of the payout wallet" — a
  // standing false drain alarm on the one surface that is supposed to raise a
  // real one. A control that always cries wolf is worse than no control.
  // AND BOTH SIDES MUST COVER THE SAME RAIL. The received side is one wallet's
  // USDC balance, so the booked side may only contain money that moved on that
  // chain. Handing it total booked revenue made the first live CARD sale read
  // as a $9 on-chain shortfall, and printed "USDC was swept out of the payout
  // wallet" about money that had arrived safely at Stripe — the same false
  // drain alarm as before, from the same function, on the axis the earlier fix
  // did not consider. Every card sale we ever make would have widened it.
  const bookedFromCustomers = money(safe(input.on_chain_booked_from_customers_usd));
  const delta = money(receivedFromCustomers - bookedFromCustomers);

  let status: ReconcileStatus;
  if (Math.abs(delta) < EPSILON_USD) status = 'reconciled';
  else if (delta > 0) status = 'unbooked_revenue';
  else status = 'overbooked';

  return {
    ...base,
    status,
    wallet_usd: money(balance),
    received_usd: received,
    known_non_revenue_usd: knownNonRevenue,
    received_from_customers_usd: receivedFromCustomers,
    booked_from_customers_usd: bookedFromCustomers,
    delta_usd: delta,
    note: noteFor(status, delta, receivedFromCustomers, bookedFromCustomers, unbookedCalls),
  };
}

function usd(n: number): string {
  return '$' + n.toFixed(2);
}

/**
 * `received` and `booked` here are both the FROM-CUSTOMERS figures. Passing the
 * raw booked total instead is the bug this function's caller used to have, and
 * the sentence it produced accused us of losing money we still had.
 */
function noteFor(
  status: ReconcileStatus,
  delta: number,
  received: number,
  booked: number,
  unbookedCalls: number,
): string {
  const calls =
    unbookedCalls === 0
      ? ''
      : ` ${unbookedCalls} call${unbookedCalls === 1 ? '' : 's'} ${unbookedCalls === 1 ? 'was' : 'were'} served with a payment attached that never booked a settlement.`;

  if (status === 'reconciled') {
    // Says "customer revenue" rather than "revenue" because at $0.00 the two
    // differ and the distinction is the whole point: money settled, none of it
    // from a customer. "Booked revenue matches the chain at $0.00" would be
    // true and would still read as though nothing had ever arrived.
    return `Booked customer revenue matches the chain at ${usd(booked)}.${calls}`;
  }
  if (status === 'unbooked_revenue') {
    return (
      `${usd(delta)} arrived on chain that the ledger never booked: the wallet has received ` +
      `${usd(received)} and the ledger books ${usd(booked)}.${calls} Real money, unrecorded — the payment path serves ` +
      `on ambiguity by design, so a settlement it could not confirm still moved funds.`
    );
  }
  return (
    `The ledger books ${usd(booked)} but the chain accounts for only ${usd(received)}, a shortfall of ` +
    `${usd(Math.abs(delta))}. Either revenue was booked that never arrived, or USDC was swept out of the payout ` +
    `wallet without being declared in TREASURY_WITHDRAWN_USD.${calls}`
  );
}
