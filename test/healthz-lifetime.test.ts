import { describe, expect, it } from 'vitest';
import { publicHealthLifetime } from '../src/usage.js';

/**
 * /healthz is public and unauthenticated, and llms.txt points machines at it.
 * It once shipped the WHOLE lifetime object, so revenue_from_customers_usd and
 * the revenue_note prose were readable by any prospect at maximum scrutiny. The
 * fix filters lifetime to operational demand only; these tests are the teeth,
 * built to fail if a commercial field ever reappears — including a field nobody
 * has added yet.
 */
describe('publicHealthLifetime: operational demand only, never commercial', () => {
  // A full ledger snapshot with every commercial field the leak exposed.
  const full: Record<string, unknown> = {
    calls: 100,
    free: 50,
    wall_hits: 10,
    degraded_calls: 2,
    // Commercially sensitive for a reason the other fields are not: a non-zero
    // count tells an anonymous prober that SOME engagement has been sold, which
    // is precisely what the identical-404 on `guardSettled` exists to withhold.
    repeat_purchases_refused: 3,
    paid_calls: 40,
    pass_calls: 8,
    settlements: 5,
    revenue_usd: 18.06,
    revenue_from_customers_usd: 0.02,
    revenue_note: 'Revenue from customers is $0.02.',
    known_non_revenue_usd: 9.04,
    self_revenue_usd: 9,
    unattributed_revenue_usd: 0,
    attributed_revenue_usd: 0.02,
    external_clients: 29,
    internal_calls: 3,
    unique_clients: 12,
    payment_attempted: 12,
    payment_failures: 0,
  };

  it('keeps the operational demand counters the status page reads', () => {
    const pub = publicHealthLifetime(full);
    expect(pub.calls).toBe(100);
    expect(pub.free).toBe(50);
    expect(pub.wall_hits).toBe(10);
    expect(pub.degraded_calls).toBe(2);
  });

  it('leaks NO revenue / settlement / customer / client field, even with all present', () => {
    const pub = publicHealthLifetime(full);
    for (const key of Object.keys(pub)) {
      expect(key).not.toMatch(/revenue|settle|customer|client|attributed|non_revenue|paid|pass|payment/i);
    }
    // Explicit: the exact fields the live leak exposed are gone.
    for (const gone of [
      'revenue_usd',
      'revenue_from_customers_usd',
      'revenue_note',
      'settlements',
      'known_non_revenue_usd',
      'self_revenue_usd',
      'unattributed_revenue_usd',
      'attributed_revenue_usd',
      'external_clients',
      'internal_calls',
      'unique_clients',
      'payment_attempted',
      'payment_failures',
      'paid_calls',
      'pass_calls',
      'repeat_purchases_refused',
    ]) {
      expect(pub).not.toHaveProperty(gone);
    }
  });

  it('is an ALLOWLIST — a new sensitive field added to the ledger stays hidden by default', () => {
    const widened = publicHealthLifetime({ ...full, revenue_this_quarter_usd: 9999, new_customer_ltv: 500 });
    expect(widened).not.toHaveProperty('revenue_this_quarter_usd');
    expect(widened).not.toHaveProperty('new_customer_ltv');
    // still only the four operational keys
    expect(Object.keys(widened).sort()).toEqual(['calls', 'degraded_calls', 'free', 'wall_hits']);
  });
});
