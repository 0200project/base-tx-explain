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

describe('settlement attribution in the ledger', () => {
  async function load() {
    vi.resetModules();
    process.env.DATA_DIR = `/tmp/self-${Math.random().toString(36).slice(2)}`;
    const attribution = await import('../src/attribution.js');
    attribution._resetAttribution();
    const usage = await import('../src/usage.js');
    return { usage, attribution };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  const settle = (m: { recordEvent: (e: never) => void }, over: Record<string, unknown>) =>
    m.recordEvent({
      t: '2026-08-21T21:00:00.000Z', e: 'settled', client: 'stripe', amount_usd: 9, ...over,
    } as never);

  const lt = (m: { usageSnapshot: () => unknown }) =>
    (m.usageSnapshot() as { lifetime: Record<string, number> }).lifetime;

  it('a self purchase books as settled but never as customer revenue', async () => {
    const { usage } = await load();
    settle(usage, { self: true, id: 'cs_self' });
    const l = lt(usage);
    expect(l.revenue_usd).toBe(9);        // the money really did settle
    expect(l.self_revenue_usd).toBe(9);   // and we know whose it is
    expect(l.revenue_from_customers_usd).toBe(0);
    expect(l.unattributed_revenue_usd).toBe(0); // resolved, not awaiting anything
  });

  /**
   * The reframe that made both failure directions safe. Asking "is it us" or
   * "is it a stranger" are both questions about the PAYER, need configuration,
   * and one of them must fail open — in the flattering direction. "Has anyone
   * looked at this yet" is a question about OUR PROCESS, always answerable,
   * and its birth state is the safe one.
   */
  it('a REAL sale is unattributed until a human says otherwise', async () => {
    const { usage } = await load();
    settle(usage, { id: 'cs_real' });
    const l = lt(usage);
    expect(l.revenue_usd).toBe(9);
    expect(l.revenue_from_customers_usd).toBe(0);  // under-reports: the safe direction
    expect(l.unattributed_revenue_usd).toBe(9);    // and says so, visibly
  });

  it('promotion moves it into customer revenue', async () => {
    const { usage, attribution } = await load();
    attribution.attribute('cs_real');
    settle(usage, { id: 'cs_real' });
    const l = lt(usage);
    expect(l.revenue_from_customers_usd).toBe(9);
    expect(l.unattributed_revenue_usd).toBe(0);
  });

  it('promotion is reversible, or nobody will risk making one', async () => {
    const { usage, attribution } = await load();
    attribution.attribute('cs_real');
    expect(attribution.unattribute('cs_real')).toEqual({ removed: true });
    settle(usage, { id: 'cs_real' });
    expect(lt(usage).revenue_from_customers_usd).toBe(0);
  });

  it('a settlement with no id can never be promoted', async () => {
    // An arrival nobody can name is one nobody can vouch for. It stays
    // unattributed rather than being waved through.
    const { usage } = await load();
    settle(usage, {});
    const l = lt(usage);
    expect(l.unattributed_revenue_usd).toBe(9);
    expect(l.revenue_from_customers_usd).toBe(0);
  });

  it('the three buckets always sum to what actually settled', async () => {
    // The property that makes the figures reconcilable against each other.
    // Two of our numbers disagreeing is how a night gets lost.
    const { usage, attribution } = await load();
    attribution.attribute('cs_promoted');
    settle(usage, { id: 'cs_self', self: true });
    settle(usage, { id: 'cs_promoted' });
    settle(usage, { id: 'cs_pending' });
    const l = lt(usage);
    expect(
      l.self_revenue_usd + l.attributed_revenue_usd + l.known_non_revenue_usd + l.unattributed_revenue_usd,
    ).toBe(l.revenue_usd);
    expect(l.revenue_usd).toBe(27);
  });

  /**
   * PRODUCTION ORDERING. The webhook arrives first and a human promotes minutes
   * later; the reverse cannot happen. Every earlier test in this file called
   * attribute() BEFORE settle(), so 312 green tests confirmed a sequence that
   * does not occur — a test can only check the story its author believed about
   * the inputs, and here the story was the wrong way round.
   *
   * Found by Security writing this exact test against the live code.
   */
  it('promotion moves the number when the settlement arrived FIRST', async () => {
    const { usage, attribution } = await load();
    settle(usage, { id: 'cs_real' });
    expect(lt(usage).unattributed_revenue_usd).toBe(9);

    attribution.attribute('cs_real');

    const l = lt(usage);
    expect(l.revenue_from_customers_usd).toBe(9);
    expect(l.attributed_revenue_usd).toBe(9);
    expect(l.unattributed_revenue_usd).toBe(0);
  });

  it('un-promotion returns it, with the settlement already recorded', async () => {
    const { usage, attribution } = await load();
    settle(usage, { id: 'cs_real' });
    attribution.attribute('cs_real');
    expect(lt(usage).revenue_from_customers_usd).toBe(9);

    attribution.unattribute('cs_real');

    const l = lt(usage);
    expect(l.revenue_from_customers_usd).toBe(0);
    expect(l.unattributed_revenue_usd).toBe(9);
  });

  /**
   * `unattributed` means AWAITING A HUMAN. An arrival already written off in
   * KNOWN_NON_REVENUE, with a paragraph naming who paid it and why it was a
   * favour, is not awaiting anyone — it is resolved to a third answer.
   *
   * Reporting it as unattributed put two of our own statements in contradiction
   * on the same public endpoint, and worse, gave the bucket a permanent floor:
   * a real $9 sale would read 9.02, indistinguishable at a glance from the
   * number already sitting there. A bucket that is always lit is one nobody
   * looks at twice.
   */
  it('a documented non-revenue arrival is RESOLVED, not awaiting anyone', async () => {
    const { usage } = await load();
    // The real Circadian probe hash, as it appears in the production ledger.
    settle(usage, {
      amount_usd: 0.02,
      tx: '0x6ce5e3948c9c6b8e0ef8413f3c29623163bb7b58155eda90a67464f3bb119110',
    });
    const l = lt(usage);
    expect(l.known_non_revenue_usd).toBe(0.02);
    expect(l.unattributed_revenue_usd).toBe(0);
    expect(l.revenue_from_customers_usd).toBe(0);
  });

  it('so unattributed rests at zero, and means something when it is not', async () => {
    const { usage } = await load();
    settle(usage, {
      amount_usd: 0.02,
      tx: '0x6ce5e3948c9c6b8e0ef8413f3c29623163bb7b58155eda90a67464f3bb119110',
    });
    expect(lt(usage).unattributed_revenue_usd).toBe(0);

    settle(usage, { id: 'cs_new_sale' });
    // Reads 9, not 9.02: unambiguous at a glance.
    expect(lt(usage).unattributed_revenue_usd).toBe(9);
  });

  it('a written-off arrival cannot be promoted into revenue by a click', async () => {
    // The written record outranks the button, so a mis-click cannot turn a
    // documented favour into our first sale.
    const { usage, attribution } = await load();
    const tx = '0x6ce5e3948c9c6b8e0ef8413f3c29623163bb7b58155eda90a67464f3bb119110';
    attribution.attribute(tx);
    settle(usage, { amount_usd: 0.02, tx, id: tx });
    const l = lt(usage);
    expect(l.revenue_from_customers_usd).toBe(0);
    expect(l.known_non_revenue_usd).toBe(0.02);
  });

  /**
   * PRODUCTION ORDER, and asserting on what attribute() RETURNED rather than
   * only on the buckets afterwards.
   *
   * The previous version of this test called attribute() before settle() — the
   * author's order — inside the test written to demonstrate the fix for the
   * author's order. And it never checked the return value, so it passed while
   * the function reported success for something it had not done.
   */
  it('REFUSES to promote a written-off arrival, and records nothing', async () => {
    const { usage, attribution } = await load();
    const tx = '0x6ce5e3948c9c6b8e0ef8413f3c29623163bb7b58155eda90a67464f3bb119110';

    settle(usage, { amount_usd: 0.02, tx, id: tx });
    const result = attribution.attribute(tx) as { promoted: boolean; reason?: string; why?: string };

    // 1. It must not claim success for something it did not do.
    expect(result.promoted).toBe(false);
    expect(result.reason).toBe('known_non_revenue');
    // 2. It must say WHY, so the operator is not left guessing.
    expect(String(result.why ?? '')).toMatch(/favour|probe|declined/i);

    // 3. THE LANDMINE. Nothing may be persisted. A suppressed-but-stored
    //    promotion sits inert only while isKnownNonRevenue is checked first,
    //    and would activate by itself the day anyone edits KNOWN_NON_REVENUE —
    //    money moving into customer revenue with nobody clicking at that
    //    moment, caused by a click months earlier.
    expect(attribution.isAttributed(tx)).toBe(false);
  });

  it('a legitimate promotion still works and still says so', async () => {
    // The guard must refuse the written-off case WITHOUT breaking the case the
    // endpoint exists for.
    const { usage, attribution } = await load();
    settle(usage, { id: 'cs_ordinary' });
    const result = attribution.attribute('cs_ordinary') as { promoted: boolean };
    expect(result.promoted).toBe(true);
    expect(attribution.isAttributed('cs_ordinary')).toBe(true);
    expect(lt(usage).revenue_from_customers_usd).toBe(9);
  });

  it('never reports a negative customer figure', async () => {
    const { usage } = await load();
    settle(usage, { amount_usd: 0.01, self: true, id: 'x' });
    expect(lt(usage).revenue_from_customers_usd).toBeGreaterThanOrEqual(0);
  });
});
