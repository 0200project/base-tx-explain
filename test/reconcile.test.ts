import { describe, expect, it } from 'vitest';
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
    const r = reconcile(input({ treasury: { usdc_balance: 0.06, wallet, read_at: null }, booked_usd: 0.06, settlements: 3, paid_calls: 3 }));
    expect(r.status).toBe('reconciled');
    expect(r.delta_usd).toBe(0);
    expect(r.unbooked_paid_calls).toBe(0);
  });

  // The state this check was built for, measured 2026-08-20: one $0.02 payment
  // on chain, nothing booked, three calls served against a payment.
  it('names the delta when money arrived that was never booked', () => {
    const r = reconcile(input({ treasury: { usdc_balance: 0.02, wallet, read_at: null }, booked_usd: 0, settlements: 0, paid_calls: 3 }));
    expect(r.status).toBe('unbooked_revenue');
    expect(r.delta_usd).toBe(0.02);
    expect(r.received_usd).toBe(0.02);
    expect(r.unbooked_paid_calls).toBe(3);
    expect(r.unbooked_notional_usd).toBe(0.06);
    expect(r.note).toContain('$0.02');
  });

  it('flags overbooking when the ledger claims more than the chain holds', () => {
    const r = reconcile(input({ treasury: { usdc_balance: 0.02, wallet, read_at: null }, booked_usd: 9.02, settlements: 2, paid_calls: 2 }));
    expect(r.status).toBe('overbooked');
    expect(r.delta_usd).toBe(-9);
    expect(r.note).toContain('TREASURY_WITHDRAWN_USD');
  });

  it('adds declared sweeps back so a withdrawal is not read as a shortfall', () => {
    const r = reconcile(input({ treasury: { usdc_balance: 0, wallet, read_at: null }, booked_usd: 9, settlements: 1, paid_calls: 1, withdrawn_usd: 9 }));
    expect(r.status).toBe('reconciled');
    expect(r.received_usd).toBe(9);
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
    const r = reconcile(input({ treasury: { usdc_balance: 0.06, wallet, read_at: null }, booked_usd: booked, settlements: 3, paid_calls: 3 }));
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
