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

/**
 * Money that arrived in the payout wallet and is NOT revenue.
 *
 * The reconciler compares what the wallet received against what the ledger
 * booked, and called any positive delta unbooked revenue. That has no concept
 * of a known non-revenue arrival, so our own test money made it permanently
 * assert unrecorded revenue that does not exist — and the only way it could
 * ever read `reconciled` was if someone wrongly booked $0.02 to silence it.
 *
 * This is the fourth appearance of one missing invariant, restated per rail:
 * revenue is booked only from a confirmed, live, settled payment, and every
 * surface that displays money must distinguish attempted from received. The
 * earlier three were an unconditional settle booking, payment attempts reading
 * as revenue on the dashboard, and Stripe test-mode purchases. This one is
 * worse than those because it is automated: it does not need anyone to misread
 * a field, it asserts the wrong thing in prose.
 *
 * Listed by transaction hash rather than as a lump sum, because a hash survives
 * a re-read, documents its own reason, and cannot silently absorb a future
 * arrival the way a number can.
 */
export interface KnownNonRevenue {
  /** Base transaction hash, or a marker when the arrival predates our records. */
  tx: string;
  amount_usd: number;
  why: string;
}

export const KNOWN_NON_REVENUE: KnownNonRevenue[] = [
  {
    // Verified on chain: both wallets have zero outbound transactions because
    // the value moved by EIP-3009, where the payer signs and the facilitator
    // submits. Budget 4.98 + payout 0.02 = the 5.00 originally funded.
    tx: 'internal-transfer-2026-08-20-selftest',
    amount_usd: 0.02,
    why: 'Internal transfer, budget wallet to payout wallet, during our own first paid-call test. Same company on both sides, net cash effect zero. Never revenue.',
  },
];

export type ReconcileStatus = 'reconciled' | 'unbooked_revenue' | 'overbooked' | 'unknown';

export interface ReconcileInput {
  treasury: TreasurySnapshot;
  /** lifetime.revenue_usd — the sum of confirmed `settled` events. */
  booked_usd: number;
  /** lifetime.settlements — count of confirmed settlements. */
  settlements: number;
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
  const settlements = Math.max(0, Math.trunc(safe(input.settlements)));
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
      known_non_revenue_usd: money(KNOWN_NON_REVENUE.reduce((t, k) => t + k.amount_usd, 0)),
      received_from_customers_usd: null,
      delta_usd: null,
      note:
        'Cannot reconcile: the payout wallet balance could not be read, so booked revenue of ' +
        usd(booked) +
        ' is unverified against the chain.',
    };
  }

  const received = money(balance + withdrawn);
  const knownNonRevenue = money(KNOWN_NON_REVENUE.reduce((t, k) => t + k.amount_usd, 0));
  const receivedFromCustomers = money(received - knownNonRevenue);
  const delta = money(receivedFromCustomers - booked);

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
    delta_usd: delta,
    note: noteFor(status, delta, receivedFromCustomers, booked, unbookedCalls),
  };
}

function usd(n: number): string {
  return '$' + n.toFixed(2);
}

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
    return `Booked revenue matches the chain at ${usd(booked)}.${calls}`;
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
