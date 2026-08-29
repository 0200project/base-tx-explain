import { describe, expect, it } from 'vitest';
import { KNOWN_NON_REVENUE, bookedNonRevenueTotal, knownNonRevenueTotal } from '../src/knownNonRevenue.js';

/**
 * Every case sits on top of whatever finance has logged as known non-revenue.
 * Derived from the real list rather than hardcoded, because hardcoding it broke
 * all of these the moment a second favour was recorded — and it would break
 * again on the third. The tests are about the reconciler's behaviour, not about
 * how many favours happen to exist today.
 */
const BASE = knownNonRevenueTotal();

/**
 * What the LEDGER booked for those favours.
 *
 * `booked_usd` is fed `usage.lifetime.revenue_usd` in production — the RAW
 * total, favours included. These tests originally passed a customer-only figure
 * instead, which quietly asserted the wrong contract and is the reason the
 * asymmetric-comparison bug shipped: the reconciler stripped every arrival from
 * the received side and nothing from the booked side, so on the live server the
 * $0.02 probe read as a $0.02 shortfall and /stats printed "USDC was swept out
 * of the payout wallet" for a wallet nobody had touched.
 *
 * So every case here now adds NR_BOOKED to the customer figure, exactly as the
 * real ledger does. If a test wants "customers booked $X", it passes
 * `X + NR_BOOKED`.
 */
const NR_BOOKED = bookedNonRevenueTotal();
import { declaredWithdrawn, reconcile, type ReconcileInput } from '../src/reconcile.js';

const wallet = '0xd4ec730ab062f20460727710fce70664948a6bc9';

function input(over: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    treasury: { usdc_balance: 0, wallet, read_at: '2026-08-21T02:00:00.000Z' },
    booked_usd: 0,
    on_chain_booked_from_customers_usd: 0,
    settlements: 0,
    on_chain_settlements: 0,
    paid_calls: 0,
    price_usd: 0.02,
    withdrawn_usd: 0,
    ...over,
  };
}

describe('reconcile', () => {
  it('reports reconciled when booked revenue matches the chain', () => {
    const r = reconcile(input({ treasury: { usdc_balance: BASE + 0.06, wallet, read_at: null }, booked_usd: 0.06 + NR_BOOKED, on_chain_booked_from_customers_usd: 0.06, settlements: 3, on_chain_settlements: 3, paid_calls: 3 }));
    expect(r.status).toBe('reconciled');
    expect(r.delta_usd).toBe(0);
    expect(r.unbooked_paid_calls).toBe(0);
    // Raw stays raw; the customer figure is the derived one.
    expect(r.booked_usd).toBe(0.06 + NR_BOOKED);
    expect(r.booked_from_customers_usd).toBe(0.06);
  });

  // The state this check was built for, measured 2026-08-20: one $0.02 payment
  // on chain, nothing booked, three calls served against a payment.
  it('names the delta when money arrived that was never booked', () => {
    const r = reconcile(input({ treasury: { usdc_balance: BASE + 0.02, wallet, read_at: null }, booked_usd: NR_BOOKED, settlements: 0, on_chain_settlements: 0, paid_calls: 3 }));
    expect(r.status).toBe('unbooked_revenue');
    expect(r.delta_usd).toBe(0.02);
    expect(r.received_usd).toBe(BASE + 0.02);
    // The raw arrival is 0.04; 0.02 of it is our own money, so only 0.02
    // is attributable to a customer and that is what the delta reports.
    expect(r.known_non_revenue_usd).toBe(BASE);
    expect(r.received_from_customers_usd).toBe(0.02);
    expect(r.unbooked_paid_calls).toBe(3);
    expect(r.unbooked_notional_usd).toBe(0.06);
    expect(r.note).toContain('$0.02');
  });

  it('flags overbooking when the ledger claims more than the chain holds', () => {
    const r = reconcile(input({ treasury: { usdc_balance: BASE, wallet, read_at: null }, booked_usd: 9.02 + NR_BOOKED, on_chain_booked_from_customers_usd: 9.02, settlements: 2, on_chain_settlements: 2, paid_calls: 2 }));
    expect(r.status).toBe('overbooked');
    expect(r.delta_usd).toBe(-9.02);
    expect(r.note).toContain('TREASURY_WITHDRAWN_USD');
  });

  it('adds declared sweeps back so a withdrawal is not read as a shortfall', () => {
    const r = reconcile(input({ treasury: { usdc_balance: BASE, wallet, read_at: null }, booked_usd: 9 + NR_BOOKED, on_chain_booked_from_customers_usd: 9, settlements: 1, on_chain_settlements: 1, paid_calls: 1, withdrawn_usd: 9 }));
    expect(r.status).toBe('reconciled');
    // round6 to match the reconciler: once BASE grew to $9.06, the raw float
    // BASE + 9 is 18.060000000000002, while the reconciler rounds to 18.06.
    expect(r.received_usd).toBe(Number((BASE + 9).toFixed(6)));
  });

  /**
   * A CARD SALE MUST NOT LOOK LIKE AN ON-CHAIN DRAIN.
   *
   * The live failure, 2026-08-23: the first real card purchase settled $9 at
   * Stripe, the reconciler compared total booked revenue against the x402
   * payout wallet, and `/stats` announced a $9 shortfall with the words "USDC
   * was swept out of the payout wallet without being declared." No USDC had
   * moved. Every card sale we ever make would have widened that phantom gap.
   *
   * It is the second time this function shipped a false drain alarm, and the
   * comment above the delta already said BOTH SIDES MUST EXCLUDE THE SAME
   * THING. What it missed is that both sides must also cover the same RAIL.
   */
  it('does NOT report a shortfall when revenue was booked on a rail the wallet never sees', () => {
    const r = reconcile(
      input({
        treasury: { usdc_balance: BASE, wallet, read_at: null },
        // The ledger's raw total includes a $9 card sale...
        booked_usd: 9 + NR_BOOKED,
        // ...which never touched the chain, so the on-chain figure excludes it.
        on_chain_booked_from_customers_usd: 0,
        settlements: 2,
        paid_calls: 2,
      }),
    );
    expect(r.status).toBe('reconciled');
    expect(r.delta_usd).toBe(0);
    expect(r.note).not.toContain('swept out');
    expect(r.note).not.toContain('shortfall');
    // The raw total still tells the truth about what was booked overall — it is
    // reported, just never compared against a single rail's wallet.
    expect(r.booked_usd).toBe(9 + NR_BOOKED);
  });

  /**
   * AND A CARD SALE MUST NOT CANCEL AN UNBOOKED x402 CALL.
   *
   * Same cross-rail error as the delta, one field over, and this one fails in
   * the flattering direction. `paid_calls` counts calls that arrived carrying an
   * x402 payload — a single rail — so subtracting settlements from EVERY rail
   * means each card sale quietly erases one unbooked call from the report. A
   * healthy card business would drive this counter to zero and hide a genuine
   * x402 leak completely.
   *
   * Found on 2026-08-23 while investigating what the "8 unbooked calls" were.
   * Production had 10 payment-attached calls and 2 settlements — but one of
   * those settlements was the Stripe pass sale, so the honest count was 9.
   */
  it('does not let a card settlement cancel an unbooked x402 call', () => {
    const r = reconcile(
      input({
        treasury: { usdc_balance: BASE, wallet, read_at: null },
        booked_usd: 9 + NR_BOOKED,
        on_chain_booked_from_customers_usd: 0,
        // Two settlements total, only one of which moved on chain.
        settlements: 2,
        on_chain_settlements: 1,
        paid_calls: 10,
      }),
    );
    // 10 payment-attached calls minus the ONE on-chain settlement = 9.
    // Subtracting both would have reported 8 and understated the gap.
    expect(r.unbooked_paid_calls).toBe(9);
    expect(r.unbooked_notional_usd).toBe(0.18);
  });

  it('still catches a REAL on-chain shortfall, so the fix did not just mute the alarm', () => {
    // The distinction that matters: silencing the false alarm must not silence
    // the true one. Here the money genuinely was booked on chain and is gone.
    const r = reconcile(
      input({
        treasury: { usdc_balance: BASE, wallet, read_at: null },
        booked_usd: 5 + NR_BOOKED,
        on_chain_booked_from_customers_usd: 5,
        settlements: 2,
        paid_calls: 2,
      }),
    );
    expect(r.status).toBe('overbooked');
    expect(r.delta_usd).toBe(-5);
    expect(r.note).toContain('TREASURY_WITHDRAWN_USD');
  });

  it('degrades to unknown rather than guessing when the balance read failed', () => {
    const r = reconcile(input({ treasury: { usdc_balance: null, wallet, read_at: null, error: 'rpc down' }, booked_usd: 0.04, settlements: 2, on_chain_settlements: 2, paid_calls: 2 }));
    expect(r.status).toBe('unknown');
    expect(r.delta_usd).toBeNull();
    expect(r.received_usd).toBeNull();
    expect(r.wallet_usd).toBeNull();
  });

  it('tolerates float drift on summed cents instead of crying divergence', () => {
    const booked = 0.02 + 0.02 + 0.02; // 0.06000000000000001
    const r = reconcile(input({ treasury: { usdc_balance: BASE + 0.06, wallet, read_at: null }, booked_usd: booked + NR_BOOKED, on_chain_booked_from_customers_usd: booked, settlements: 3, on_chain_settlements: 3, paid_calls: 3 }));
    expect(r.status).toBe('reconciled');
  });

  it('never throws on a malformed snapshot: /stats must not 500 over a report', () => {
    const bad = { treasury: undefined, booked_usd: NaN, settlements: -5, paid_calls: undefined, price_usd: NaN, withdrawn_usd: NaN } as unknown as ReconcileInput;
    const r = reconcile(bad);
    expect(r.status).toBe('unknown');
    expect(r.booked_usd).toBe(0);
    expect(r.unbooked_paid_calls).toBe(0);
  });

  it('reads declared sweeps from the environment, ignoring junk and negatives', () => {
    expect(declaredWithdrawn({} as NodeJS.ProcessEnv)).toBe(0);
    expect(declaredWithdrawn({ TREASURY_WITHDRAWN_USD: '12.5' } as NodeJS.ProcessEnv)).toBe(12.5);
    expect(declaredWithdrawn({ TREASURY_WITHDRAWN_USD: 'nope' } as NodeJS.ProcessEnv)).toBe(0);
    expect(declaredWithdrawn({ TREASURY_WITHDRAWN_USD: '-3' } as NodeJS.ProcessEnv)).toBe(0);
  });
});

describe('known non-revenue must not read as unbooked revenue', () => {
  const wallet = '0xd4ec730ab062f20460727710fce70664948a6bc9';

  /**
   * The live bug this fixes: our own $0.02 test transfer sat in the payout
   * wallet, and the reconciler compared raw receipts against booked revenue and
   * declared unrecorded revenue that did not exist. It could never read
   * `reconciled` unless somebody wrongly booked $0.02 to silence it.
   */
  it("reads reconciled when the only arrival is our own money", () => {
    const r = reconcile({
      treasury: { usdc_balance: BASE, wallet, read_at: null },
      booked_usd: NR_BOOKED, settlements: 0, on_chain_settlements: 0, paid_calls: 4, price_usd: 0.02, withdrawn_usd: 0,
    });
    expect(r.status).toBe('reconciled');
    expect(r.delta_usd).toBe(0);
    // The raw figure is still reported — it just is not labelled as revenue.
    expect(r.received_usd).toBe(BASE);
    expect(r.received_from_customers_usd).toBe(0);
  });

  it('still catches a genuine unbooked arrival sitting on top of ours', () => {
    // The property that matters: excluding our money must not blind the check.
    const r = reconcile({
      treasury: { usdc_balance: BASE + 9, wallet, read_at: null },
      booked_usd: NR_BOOKED, settlements: 0, on_chain_settlements: 0, paid_calls: 0, price_usd: 0.02, withdrawn_usd: 0,
    });
    expect(r.status).toBe('unbooked_revenue');
    expect(r.delta_usd).toBe(9);
  });

  it('reports the known-non-revenue figure so the adjustment is auditable', () => {
    const r = reconcile({
      treasury: { usdc_balance: BASE, wallet, read_at: null },
      booked_usd: NR_BOOKED, settlements: 0, on_chain_settlements: 0, paid_calls: 0, price_usd: 0.02, withdrawn_usd: 0,
    });
    // A silent adjustment is its own hazard: finance must see what was excluded.
    expect(r.known_non_revenue_usd).toBe(BASE);
  });

  /**
   * THE LIVE STATE, read off the deployed server 2026-08-21T18:02Z, where this
   * bug was found by curling /stats and reading the sentence rather than by any
   * test going red.
   *
   * balance $0.04 · booked $0.02 (the Circadian probe) · nothing swept. Every
   * cent is accounted for and nothing is missing, yet the reconciler reported
   * `overbooked` with "USDC was swept out of the payout wallet without being
   * declared" — a permanent, self-inflicted drain alarm on the surface that is
   * supposed to raise a real one.
   *
   * Pinned to literal amounts rather than derived from the list on purpose: if
   * a future favour changes the totals, this test should be re-reasoned rather
   * than silently follow along, because it is a record of a specific state that
   * was misreported and not a general property.
   */
  it('does not accuse us of losing money that was booked as a favour and stayed put', () => {
    // RE-REASONED 2026-08-29, exactly as the comment above instructs — and this
    // time the re-reasoning records a milestone. Two settlements landed since
    // the last one: the founder's $9 buy_pass self-test (tx 0x5606d4f2...,
    // booked known-non-revenue) and — the first REAL customer payment in the
    // company's life — kindrat86's $0.02 (tx 0x325557e1..., promoted to
    // attributed revenue). Known-non-revenue is now $9.06; customer revenue is
    // $0.02; the payout wallet holds $9.08, which is exactly those two sums with
    // nothing swept. The property is unchanged — every cent accounted for, so
    // the reconciler must say reconciled — but it must now show $0.02 FROM
    // CUSTOMERS rather than $0. That last assertion is the line this whole
    // company spent a week earning.
    const r = reconcile({
      treasury: { usdc_balance: 9.08, wallet, read_at: '2026-08-29T22:07:00.000Z' },
      booked_usd: 9.06, on_chain_booked_from_customers_usd: 0.02, settlements: 5, on_chain_settlements: 5, paid_calls: 11, price_usd: 0.02, withdrawn_usd: 0,
    });
    expect(r.status).toBe('reconciled');
    expect(r.delta_usd).toBe(0);
    expect(r.received_from_customers_usd).toBe(0.02);
    expect(r.booked_from_customers_usd).toBe(0.02);
    // The specific sentence that was wrong. It must not come back.
    expect(r.note).not.toContain('swept out');
    expect(r.note).not.toContain('shortfall');
  });

  /**
   * The inverse, so the fix cannot be "always reconciled". A real sweep still
   * has to trip it while the same favour sits in the books.
   */
  it('still reports a shortfall when funds actually leave', () => {
    const r = reconcile({
      treasury: { usdc_balance: 0, wallet, read_at: null },
      booked_usd: 5 + NR_BOOKED, settlements: 3, on_chain_settlements: 3, paid_calls: 3, price_usd: 0.02, withdrawn_usd: 0,
    });
    expect(r.status).toBe('overbooked');
    expect(r.note).toContain('swept out');
  });
});

describe('booked vs merely arrived', () => {
  /**
   * Two denominators want the known-non-revenue list, and conflating them put
   * "$0.02 settled, of which $0.04 is not revenue" on a public endpoint — in
   * the exact place the list exists to make honest.
   *
   * Wallet receipts contain every arrival. `revenue_usd` contains only what the
   * ledger booked. Subtracting an unbooked arrival from revenue removes money
   * that was never counted.
   */
  it('never excludes more from revenue than was ever booked', () => {
    expect(bookedNonRevenueTotal()).toBeLessThanOrEqual(knownNonRevenueTotal());
  });

  it('counts every arrival for receipts, booked or not', () => {
    const all = KNOWN_NON_REVENUE.reduce((t, k) => t + k.amount_usd, 0);
    expect(knownNonRevenueTotal()).toBeCloseTo(all, 6);
  });

  it('counts only booked entries for the revenue adjustment', () => {
    const booked = KNOWN_NON_REVENUE.filter((k) => k.booked).reduce((t, k) => t + k.amount_usd, 0);
    expect(bookedNonRevenueTotal()).toBeCloseTo(booked, 6);
  });

  it('every entry declares whether it was booked, so the next one cannot omit it', () => {
    for (const k of KNOWN_NON_REVENUE) {
      expect(typeof k.booked).toBe('boolean');
      expect(k.why.length).toBeGreaterThan(20);
    }
  });
});
