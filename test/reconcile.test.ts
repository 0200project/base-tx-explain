import { describe, expect, it } from 'vitest';
import { knownNonRevenueTotal } from '../src/knownNonRevenue.js';

/**
 * Every case sits on top of whatever finance has logged as known non-revenue.
 * Derived from the real list rather than hardcoded, because hardcoding it broke
 * all of these the moment a second favour was recorded — and it would break
 * again on the third. The tests are about the reconciler's behaviour, not about
 * how many favours happen to exist today.
 */
const BASE = knownNonRevenueTotal();
import { declaredWithdrawn, reconcile, type ReconcileInput } from '../src/reconcile.js';

const wallet = '0xd4ec730ab062f20460727710fce70664948a6bc9';

function input(over: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    treasury: { usdc_balance: 0, wallet, read_at: '2026-08-21T02:00:00.000Z' },
    booked_usd: 0,
    settlements: 0,
    paid_calls: 0,
    price_usd: 0.02,
    withdrawn_usd: 0,
    ...over,
  };
}

describe('reconcile', () => {
  it('reports reconciled when booked revenue matches the chain', () => {
    const r = reconcile(input({ treasury: { usdc_balance: BASE + 0.06, wallet, read_at: null }, booked_usd: 0.06, settlements: 3, paid_calls: 3 }));
    expect(r.status).toBe('reconciled');
    expect(r.delta_usd).toBe(0);
    expect(r.unbooked_paid_calls).toBe(0);
  });

  // The state this check was built for, measured 2026-08-20: one $0.02 payment
  // on chain, nothing booked, three calls served against a payment.
  it('names the delta when money arrived that was never booked', () => {
    const r = reconcile(input({ treasury: { usdc_balance: BASE + 0.02, wallet, read_at: null }, booked_usd: 0, settlements: 0, paid_calls: 3 }));
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
    const r = reconcile(input({ treasury: { usdc_balance: BASE, wallet, read_at: null }, booked_usd: 9.02, settlements: 2, paid_calls: 2 }));
    expect(r.status).toBe('overbooked');
    expect(r.delta_usd).toBe(-9.02);
    expect(r.note).toContain('TREASURY_WITHDRAWN_USD');
  });

  it('adds declared sweeps back so a withdrawal is not read as a shortfall', () => {
    const r = reconcile(input({ treasury: { usdc_balance: BASE, wallet, read_at: null }, booked_usd: 9, settlements: 1, paid_calls: 1, withdrawn_usd: 9 }));
    expect(r.status).toBe('reconciled');
    expect(r.received_usd).toBe(BASE + 9);
  });

  it('degrades to unknown rather than guessing when the balance read failed', () => {
    const r = reconcile(input({ treasury: { usdc_balance: null, wallet, read_at: null, error: 'rpc down' }, booked_usd: 0.04, settlements: 2, paid_calls: 2 }));
    expect(r.status).toBe('unknown');
    expect(r.delta_usd).toBeNull();
    expect(r.received_usd).toBeNull();
    expect(r.wallet_usd).toBeNull();
  });

  it('tolerates float drift on summed cents instead of crying divergence', () => {
    const booked = 0.02 + 0.02 + 0.02; // 0.06000000000000001
    const r = reconcile(input({ treasury: { usdc_balance: BASE + 0.06, wallet, read_at: null }, booked_usd: booked, settlements: 3, paid_calls: 3 }));
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
      booked_usd: 0, settlements: 0, paid_calls: 4, price_usd: 0.02, withdrawn_usd: 0,
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
      booked_usd: 0, settlements: 0, paid_calls: 0, price_usd: 0.02, withdrawn_usd: 0,
    });
    expect(r.status).toBe('unbooked_revenue');
    expect(r.delta_usd).toBe(9);
  });

  it('reports the known-non-revenue figure so the adjustment is auditable', () => {
    const r = reconcile({
      treasury: { usdc_balance: BASE, wallet, read_at: null },
      booked_usd: 0, settlements: 0, paid_calls: 0, price_usd: 0.02, withdrawn_usd: 0,
    });
    // A silent adjustment is its own hazard: finance must see what was excluded.
    expect(r.known_non_revenue_usd).toBe(BASE);
  });
});
