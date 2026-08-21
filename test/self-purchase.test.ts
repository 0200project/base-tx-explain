import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isSelfPurchase } from '../src/stripe.js';

/**
 * Our own proving purchase must not read as the first sale.
 *
 * The founder is expected to buy a $9 pass himself to prove the card rail works
 * end to end. That purchase is `livemode: true`, so it books as revenue, and
 * `/healthz` is public and unauthenticated. Without this it would report
 * `revenue_from_customers_usd: 9.00` on the night that number is being watched
 * — the same failure removed from the x402 rail today, arriving on the card
 * rail instead.
 *
 * Pre-logging it in KNOWN_NON_REVENUE was the obvious fix and is wrong:
 * subtracting money that has not arrived makes the public figure negative,
 * which is the arithmetic nonsense that file exists to prevent. Pre-logging is
 * only safe for entries already true. So the purchase labels itself instead.
 */

describe('isSelfPurchase', () => {
  beforeEach(() => {
    delete process.env.SELF_PURCHASE_EMAIL;
  });

  it('is false when no self address is configured', () => {
    // Absent config must never make a stranger's purchase look like ours —
    // that would hide a real sale, which is the one thing worse than
    // overcounting.
    expect(isSelfPurchase({ customer_email: 'someone@example.com' })).toBe(false);
  });

  it('matches the top-level customer_email', () => {
    process.env.SELF_PURCHASE_EMAIL = 'founder@example.com';
    expect(isSelfPurchase({ customer_email: 'founder@example.com' })).toBe(true);
  });

  it('matches the nested customer_details.email, which is where Stripe often puts it', () => {
    process.env.SELF_PURCHASE_EMAIL = 'founder@example.com';
    expect(isSelfPurchase({ customer_details: { email: 'founder@example.com' } })).toBe(true);
  });

  it('ignores case and surrounding whitespace on both sides', () => {
    process.env.SELF_PURCHASE_EMAIL = '  Founder@Example.COM ';
    expect(isSelfPurchase({ customer_email: 'FOUNDER@example.com' })).toBe(true);
  });

  it('does NOT match a different buyer', () => {
    process.env.SELF_PURCHASE_EMAIL = 'founder@example.com';
    expect(isSelfPurchase({ customer_email: 'stranger@elsewhere.com' })).toBe(false);
  });

  it('does not match an empty or absent email', () => {
    // Otherwise a checkout with no email captured would be silently written
    // off as ours, turning a real first sale into a rounding error.
    process.env.SELF_PURCHASE_EMAIL = 'founder@example.com';
    expect(isSelfPurchase({})).toBe(false);
    expect(isSelfPurchase({ customer_email: '' })).toBe(false);
    expect(isSelfPurchase(undefined)).toBe(false);
  });

  it('survives hostile or malformed payload shapes', () => {
    process.env.SELF_PURCHASE_EMAIL = 'founder@example.com';
    for (const bad of [{ customer_email: 42 }, { customer_details: 'nope' }, { customer_details: { email: null } }]) {
      expect(() => isSelfPurchase(bad as Record<string, unknown>)).not.toThrow();
      expect(isSelfPurchase(bad as Record<string, unknown>)).toBe(false);
    }
  });
});

describe('a self purchase in the ledger', () => {
  async function load() {
    vi.resetModules();
    process.env.DATA_DIR = `/tmp/self-${Math.random().toString(36).slice(2)}`;
    return import('../src/usage.js');
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('books the money as settled but NOT as customer revenue', async () => {
    const m = await load();
    m.recordEvent({
      t: '2026-08-21T21:00:00.000Z', e: 'settled', client: 'stripe', amount_usd: 9, self: true,
    });
    const snap = m.usageSnapshot() as {
      lifetime: { revenue_usd: number; self_revenue_usd: number; revenue_from_customers_usd: number };
    };
    // The money really did settle; hiding that would be its own dishonesty.
    expect(snap.lifetime.revenue_usd).toBe(9);
    expect(snap.lifetime.self_revenue_usd).toBe(9);
    // But nobody bought anything.
    expect(snap.lifetime.revenue_from_customers_usd).toBe(0);
  });

  it('still counts a real sale as customer revenue', async () => {
    const m = await load();
    m.recordEvent({ t: '2026-08-21T21:00:00.000Z', e: 'settled', client: 'stripe', amount_usd: 9 });
    const snap = m.usageSnapshot() as { lifetime: { revenue_from_customers_usd: number } };
    // Whatever the hand-logged x402 favours subtract, a $9 card sale must
    // still show up. The exclusions must not swallow a genuine first sale.
    expect(snap.lifetime.revenue_from_customers_usd).toBeGreaterThan(8);
  });

  it('separates a self purchase from a real one in the same ledger', async () => {
    const m = await load();
    m.recordEvent({ t: '2026-08-21T21:00:00.000Z', e: 'settled', client: 'stripe', amount_usd: 9, self: true });
    m.recordEvent({ t: '2026-08-21T22:00:00.000Z', e: 'settled', client: 'stripe', amount_usd: 9 });
    const snap = m.usageSnapshot() as {
      lifetime: { revenue_usd: number; self_revenue_usd: number; revenue_from_customers_usd: number };
    };
    expect(snap.lifetime.revenue_usd).toBe(18);
    expect(snap.lifetime.self_revenue_usd).toBe(9);
    expect(snap.lifetime.revenue_from_customers_usd).toBeGreaterThan(8);
    expect(snap.lifetime.revenue_from_customers_usd).toBeLessThan(9.01);
  });

  it('never reports a negative customer figure', async () => {
    // The failure mode that killed the pre-logging idea: subtracting more than
    // was ever booked. "$0.02 settled, of which $0.04 is not revenue" reached a
    // public endpoint once already.
    const m = await load();
    m.recordEvent({ t: '2026-08-21T21:00:00.000Z', e: 'settled', client: 'stripe', amount_usd: 0.01, self: true });
    const snap = m.usageSnapshot() as { lifetime: { revenue_from_customers_usd: number } };
    expect(snap.lifetime.revenue_from_customers_usd).toBeGreaterThanOrEqual(0);
  });
});
