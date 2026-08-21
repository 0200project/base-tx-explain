import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
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
});

describe('sessionKind', () => {
  it('reads the product type from Stripe rather than guessing', () => {
    expect(sessionKind({ mode: 'subscription' })).toBe('subscription');
    expect(sessionKind({ mode: 'payment' })).toBe('pass');
    expect(sessionKind({})).toBe('pass');
  });
});
