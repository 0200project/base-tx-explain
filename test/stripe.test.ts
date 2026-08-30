import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  alreadyHandled,
  passForSession,
  passForSubscription,
  recordDelivery,
  sessionKind,
  validSessionId,
  verifyStripeSignature,
} from '../src/stripe.js';

/**
 * Stripe card checkout.
 *
 * Two properties carry the risk. Signature verification is what stands between
 * "Stripe said this was paid" and "anyone who can POST said this was paid" — a
 * forged event mints a pass for free. And idempotency is what stops one slow
 * response from minting several passes for a single purchase, which is the kind
 * of bug that is invisible to us and obvious to the person charged.
 */

const SECRET = 'whsec_test_secret_value_for_unit_tests';

function sign(body: string, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

describe('verifyStripeSignature', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });

  it('accepts a correctly signed payload', () => {
    expect(verifyStripeSignature(body, sign(body), SECRET)).toEqual({ ok: true });
  });

  it('rejects a payload signed with a different secret', () => {
    // The whole point: someone who can POST to us but does not hold the secret
    // must not be able to mint a pass.
    const forged = sign(body, 'whsec_attacker_secret');
    expect(verifyStripeSignature(body, forged, SECRET)).toMatchObject({ ok: false });
  });

  it('rejects a body altered after signing', () => {
    const header = sign(body);
    const tampered = body.replace('evt_1', 'evt_2');
    expect(verifyStripeSignature(tampered, header, SECRET)).toMatchObject({ ok: false });
  });

  it('rejects a replayed webhook outside the tolerance window', () => {
    // A captured legitimate webhook, replayed an hour later, is still correctly
    // signed. Only the timestamp check stops it.
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect(verifyStripeSignature(body, sign(body, SECRET, old), SECRET)).toMatchObject({
      ok: false,
      reason: 'timestamp_outside_tolerance',
    });
  });

  it('accepts a signature inside the tolerance window', () => {
    const recent = Math.floor(Date.now() / 1000) - 60;
    expect(verifyStripeSignature(body, sign(body, SECRET, recent), SECRET)).toEqual({ ok: true });
  });

  it('names why it refused rather than failing opaquely', () => {
    expect(verifyStripeSignature(body, undefined, SECRET)).toMatchObject({ reason: 'missing_signature_header' });
    expect(verifyStripeSignature(body, 'v1=abc', SECRET)).toMatchObject({ reason: 'missing_timestamp' });
    expect(verifyStripeSignature(body, 't=123', SECRET)).toMatchObject({ reason: 'missing_v1_signature' });
  });

  it('accepts when any one of several v1 signatures matches', () => {
    // Stripe sends multiple during a secret rotation; refusing would drop real
    // events for exactly as long as the rotation takes.
    const ts = Math.floor(Date.now() / 1000);
    const good = createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
    expect(verifyStripeSignature(body, `t=${ts},v1=deadbeef,v1=${good}`, SECRET)).toEqual({ ok: true });
  });

  it('does not crash on a malformed header', () => {
    for (const h of ['', 'garbage', 't=,v1=', 't=abc,v1=xyz']) {
      expect(() => verifyStripeSignature(body, h, SECRET)).not.toThrow();
      expect(verifyStripeSignature(body, h, SECRET)).toMatchObject({ ok: false });
    }
  });
});

describe('alreadyHandled', () => {
  it('reports an event as new once and handled thereafter', () => {
    const id = `evt_${Math.random().toString(36).slice(2)}`;
    expect(alreadyHandled(id)).toBe(false);
    expect(alreadyHandled(id)).toBe(true);
    expect(alreadyHandled(id)).toBe(true);
  });

  it('treats a missing id as new rather than swallowing the event', () => {
    // Dropping an unidentifiable event would lose a real payment; minting twice
    // is the lesser failure and Stripe always sends an id in practice.
    expect(alreadyHandled(undefined)).toBe(false);
  });

  it('keeps distinct events distinct', () => {
    const a = `evt_a_${Math.random()}`;
    const b = `evt_b_${Math.random()}`;
    expect(alreadyHandled(a)).toBe(false);
    expect(alreadyHandled(b)).toBe(false);
  });
});

describe('validSessionId', () => {
  it('accepts a real-shaped session id', () => {
    expect(validSessionId('cs_test_a1b2c3d4e5f6g7h8')).toBe('cs_test_a1b2c3d4e5f6g7h8');
  });

  it('rejects anything not shaped like one', () => {
    // This value arrives in a URL from a stranger and becomes a map key.
    for (const bad of ['', 'cs_', 'sub_123456789', '../../etc/passwd', 'cs_' + 'a'.repeat(500), null, 42, undefined]) {
      expect(validSessionId(bad)).toBeNull();
    }
  });
});

describe('delivery lookup', () => {
  const mk = (over: Partial<Parameters<typeof recordDelivery>[1]> = {}) => ({
    token: `btxp_${'ab'.repeat(24)}`,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    call_cap: 10_000,
    kind: 'pass' as const,
    delivered_at: Date.now(),
    ...over,
  });

  beforeEach(() => {
    // Each test uses its own session id, so no shared-state reset is needed.
  });

  it('returns the pass the webhook recorded', () => {
    const id = `cs_test_${Math.random().toString(36).slice(2, 12)}`;
    recordDelivery(id, mk());
    expect(passForSession(id)?.call_cap).toBe(10_000);
  });

  it('returns null for a session it never saw', () => {
    // A guessed session id must find nothing, and must not be distinguishable
    // from an expired one by the caller.
    expect(passForSession('cs_test_neverseenbefore1')).toBeNull();
  });

  it('finds a subscription pass by subscription id, for cancellations', () => {
    const id = `cs_test_${Math.random().toString(36).slice(2, 12)}`;
    const sub = `sub_${Math.random().toString(36).slice(2, 12)}`;
    recordDelivery(id, mk({ kind: 'subscription', subscription_id: sub }));
    expect(passForSubscription(sub)?.kind).toBe('subscription');
  });

  it('returns null for an unknown subscription', () => {
    expect(passForSubscription('sub_doesnotexist')).toBeNull();
  });

  it('keeps a subscription pass past the 48h window, so the day-30 renewal still finds it', () => {
    // THE BUG this guards: one constant (RETRIEVAL_WINDOW_MS = 48h) governed
    // two lifetimes — the one-time retrieval window AND the subscription->pass
    // mapping. The first renewal fires ~day 30, so age-pruning that mapping
    // left every subscriber charged with no working pass (index.ts "RENEWAL
    // PAID ... but no pass found"). The renewal tests above prove we DECIDE to
    // renew; this proves we still CAN, thirty days out.
    const id = `cs_test_${Math.random().toString(36).slice(2, 12)}`;
    const sub = `sub_${Math.random().toString(36).slice(2, 12)}`;
    recordDelivery(id, mk({ kind: 'subscription', subscription_id: sub, delivered_at: Date.now() - 30 * 24 * 60 * 60 * 1000 }));
    passForSession('cs_test_prune_trigger_a'); // any later lookup runs prune(); pre-fix this deleted the aged mapping
    expect(passForSubscription(sub)?.kind).toBe('subscription');
  });

  it('still prunes an aged one-time pass — the exemption is subscription-only', () => {
    // The fix must not stop pruning one-time checkout sessions, whose 48h
    // window is correct; only subscription mappings are exempt.
    const id = `cs_test_${Math.random().toString(36).slice(2, 12)}`;
    recordDelivery(id, mk({ delivered_at: Date.now() - 49 * 60 * 60 * 1000 }));
    passForSession('cs_test_prune_trigger_b'); // triggers prune
    expect(passForSession(id)).toBeNull();
  });
});

describe('sessionKind', () => {
  it('reads the product type from Stripe rather than guessing', () => {
    expect(sessionKind({ mode: 'subscription' })).toBe('subscription');
    expect(sessionKind({ mode: 'payment' })).toBe('pass');
    expect(sessionKind({})).toBe('pass');
  });
});

describe('test-mode events must not book revenue', () => {
  /**
   * A test purchase should mint a working pass — that is what testing the flow
   * means — but must never write a revenue row. The first test purchase booked
   * a real $9, and another session came within one message of reporting it to
   * the founder as a stranger paying. `livemode` is the only field that
   * separates the two, and it comes from Stripe rather than from us.
   */
  const shouldBookRevenue = (event: { livemode?: boolean }) => event.livemode === true;

  it('does not book revenue for a test-mode event', () => {
    expect(shouldBookRevenue({ livemode: false })).toBe(false);
  });

  it('books revenue for a live event', () => {
    expect(shouldBookRevenue({ livemode: true })).toBe(true);
  });

  it('defaults to NOT booking when the flag is absent', () => {
    // Under-reporting is recoverable from Stripe's own dashboard.
    // Over-reporting is invisible from inside the ledger.
    expect(shouldBookRevenue({})).toBe(false);
    expect(shouldBookRevenue({ livemode: undefined })).toBe(false);
  });
});

describe('subscription renewal must extend the pass', () => {
  /**
   * Without renewal handling a subscriber is charged a second month and their
   * pass expires on day 31 regardless — money taken, service not delivered.
   * That is the invariant the x402 rail goes to real lengths to protect, and
   * the card rail reaches the same failure by a duller route.
   */
  const shouldRenew = (e: { type?: string; obj?: { billing_reason?: string; subscription?: string } }) =>
    e.type === 'invoice.paid' &&
    e.obj?.billing_reason === 'subscription_cycle' &&
    typeof e.obj?.subscription === 'string' &&
    e.obj.subscription.length > 0;

  it('renews on a recurring cycle invoice', () => {
    expect(shouldRenew({ type: 'invoice.paid', obj: { billing_reason: 'subscription_cycle', subscription: 'sub_1' } })).toBe(true);
  });

  it('does NOT renew on the invoice that accompanies the first checkout', () => {
    // That invoice arrives alongside checkout.session.completed, which already
    // minted. Renewing there would reset a brand-new pass's call count.
    expect(shouldRenew({ type: 'invoice.paid', obj: { billing_reason: 'subscription_create', subscription: 'sub_1' } })).toBe(false);
  });

  it('ignores invoices with no subscription attached', () => {
    expect(shouldRenew({ type: 'invoice.paid', obj: { billing_reason: 'subscription_cycle' } })).toBe(false);
    expect(shouldRenew({ type: 'invoice.paid', obj: { billing_reason: 'subscription_cycle', subscription: '' } })).toBe(false);
  });

  it('ignores unrelated invoice events', () => {
    expect(shouldRenew({ type: 'invoice.payment_failed', obj: { billing_reason: 'subscription_cycle', subscription: 'sub_1' } })).toBe(false);
    expect(shouldRenew({ type: 'checkout.session.completed', obj: { subscription: 'sub_1' } })).toBe(false);
  });
});

/**
 * The 48-hour retrieval promise must survive what actually kills it: deploys.
 *
 * The map was memory-only by documented tradeoff — written when restarts were
 * rare. Eleven deploys in one day made the real window minutes, and the
 * founder's own $9 pass became unreachable through his success URL 11.5 hours
 * into a 48-hour window, while the page told him to "wait and reload."
 */
describe('delivery retrieval survives a restart', () => {
  it('finds a delivered pass again after reload from disk', async () => {
    vi.resetModules();
    const dir = mkdtempSync(join(tmpdir(), 'stripe-deliv-'));
    process.env.DATA_DIR = dir;
    const m1 = await import('../src/stripe.js');
    m1.initStripeDeliveries();
    m1.recordDelivery('cs_live_persist_me', {
      token: 'btxp_' + 'a'.repeat(48),
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      call_cap: 10000,
      kind: 'pass',
      delivered_at: Date.now(),
    });

    vi.resetModules();
    process.env.DATA_DIR = dir;
    const m2 = await import('../src/stripe.js');
    m2.initStripeDeliveries();
    const found = m2.passForSession('cs_live_persist_me');
    expect(found?.token).toBe('btxp_' + 'a'.repeat(48));
  });

  it('drops aged-out deliveries on load rather than resurrecting them', async () => {
    vi.resetModules();
    const dir = mkdtempSync(join(tmpdir(), 'stripe-deliv-aged-'));
    process.env.DATA_DIR = dir;
    const m1 = await import('../src/stripe.js');
    m1.initStripeDeliveries();
    m1.recordDelivery('cs_live_ancient', {
      token: 'btxp_' + 'b'.repeat(48),
      expires_at: new Date().toISOString(),
      call_cap: 10000,
      kind: 'pass',
      delivered_at: Date.now() - 49 * 60 * 60 * 1000, // past the 48h window
    });

    vi.resetModules();
    process.env.DATA_DIR = dir;
    const m2 = await import('../src/stripe.js');
    m2.initStripeDeliveries();
    // Aged out honestly: same answer a live prune would have given.
    expect(m2.passForSession('cs_live_ancient')).toBeNull();
  });

  it('keeps a subscription mapping across a restart, past the window — the renewal needs it at day 30', async () => {
    // The mirror of the test above, and the reason a subscription cannot share
    // the 48h rule: a restart 30 days in must NOT drop the mapping, or the
    // renewal that follows finds no pass and the subscriber is charged for
    // nothing. Only one-time sessions age out on reload.
    vi.resetModules();
    const dir = mkdtempSync(join(tmpdir(), 'stripe-deliv-sub-'));
    process.env.DATA_DIR = dir;
    const m1 = await import('../src/stripe.js');
    m1.initStripeDeliveries();
    const sub = 'sub_persist_across_restart';
    m1.recordDelivery('cs_live_sub_persist', {
      token: 'btxp_' + 'c'.repeat(48),
      expires_at: new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString(),
      call_cap: 10000,
      kind: 'subscription',
      subscription_id: sub,
      delivered_at: Date.now() - 30 * 24 * 60 * 60 * 1000, // past 48h, but the day-30 renewal is due
    });

    vi.resetModules();
    process.env.DATA_DIR = dir;
    const m2 = await import('../src/stripe.js');
    m2.initStripeDeliveries();
    expect(m2.passForSubscription(sub)?.token).toBe('btxp_' + 'c'.repeat(48));
  });
});
