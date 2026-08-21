import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The card rail's own health.
 *
 * The property under test is the three-state distinction. Two states are easy;
 * the third — "no delivery has ever verified" — is the one this codebase has
 * got wrong repeatedly under different names: a risk check that emits no flag
 * when it could not run, a reconciler that read `reconciled` because it
 * compared a figure against itself, a monitor that would have reported calm
 * while blind. Every one of them let silence read as a pass.
 */

async function load() {
  vi.resetModules();
  process.env.DATA_DIR = `/tmp/wh-${Math.random().toString(36).slice(2)}`;
  return import('../src/webhookHealth.js');
}

describe('webhookHealth', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('reports never_exercised before any delivery, and does NOT call it healthy', async () => {
    const m = await load();
    const h = m.webhookHealth();
    expect(h.status).toBe('never_exercised');
    expect(h.last_verified_at).toBeNull();
    expect(h.note).toContain('UNPROVEN');
  });

  it('does not raise an alert merely for being unproven', async () => {
    // Absence of evidence is not an incident. Flagging it would train someone
    // to dismiss the flag that means a customer lost money.
    const m = await load();
    expect(m.webhookHealth().needs_attention).toBe(false);
  });

  it('reports healthy once a delivery has verified', async () => {
    const m = await load();
    m.recordWebhookVerified(new Date('2026-08-21T20:00:00Z'));
    const h = m.webhookHealth();
    expect(h.status).toBe('healthy');
    expect(h.verified_count).toBe(1);
    expect(h.last_verified_at).toBe('2026-08-21T20:00:00.000Z');
    expect(h.needs_attention).toBe(false);
  });

  it('treats an unsigned hit as a probe, not as a failure', async () => {
    // Scanners and our own curls hit this endpoint. Real Stripe deliveries are
    // always signed, so no header means nobody was charged.
    const m = await load();
    m.recordWebhookRejected('missing_signature_header');
    const h = m.webhookHealth();
    expect(h.probe_count).toBe(1);
    expect(h.bad_signature_count).toBe(0);
    expect(h.status).toBe('never_exercised');
    expect(h.needs_attention).toBe(false);
  });

  it('treats a SIGNED delivery it cannot match as an incident', async () => {
    // The load-bearing case: the header was present, so Stripe really sent it,
    // so somebody was really charged and really got nothing.
    const m = await load();
    m.recordWebhookRejected('no_matching_signature');
    const h = m.webhookHealth();
    expect(h.status).toBe('REJECTING_SIGNED_DELIVERIES');
    expect(h.bad_signature_count).toBe(1);
    expect(h.needs_attention).toBe(true);
    expect(h.note).toMatch(/retries/i);
    expect(h.note).toMatch(/delivery log/i);
  });

  it('names the remedy, because the alert is useless without it', async () => {
    const m = await load();
    m.recordWebhookRejected('no_matching_signature');
    expect(m.webhookHealth().note).toContain('STRIPE_WEBHOOK_SECRET');
  });

  it('shouts to stderr on a signed rejection but stays quiet for a probe', async () => {
    const m = await load();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.recordWebhookRejected('missing_signature_header');
    expect(err).not.toHaveBeenCalled();
    m.recordWebhookRejected('no_matching_signature');
    expect(err).toHaveBeenCalledOnce();
  });

  it('keeps reporting the incident after a later success, until someone looks', async () => {
    // A rejection that stops being visible because the next delivery worked
    // would hide the window in which a customer lost money.
    const m = await load();
    m.recordWebhookRejected('no_matching_signature');
    m.recordWebhookVerified();
    const h = m.webhookHealth();
    expect(h.status).toBe('REJECTING_SIGNED_DELIVERIES');
    expect(h.verified_count).toBe(1);
    expect(h.bad_signature_count).toBe(1);
  });

  /**
   * /stripe/webhook is public by necessity, so any stranger with curl can cause
   * a rejection. The classifier must therefore ask "is this a shape ONLY a real
   * Stripe delivery could produce" rather than merely "was this rejected" —
   * otherwise the alarm is raisable from outside, faster than it can be
   * acknowledged, and the operator learns to ignore it before the day it is
   * real. Found by Security reading the classifier rather than firing it.
   */
  it('treats malformed signature headers as probes: Stripe never sends those', async () => {
    for (const r of ['missing_signature_header', 'missing_timestamp', 'missing_v1_signature']) {
      const fresh = await load();
      fresh.recordWebhookRejected(r);
      const h = fresh.webhookHealth();
      expect(h.probe_count, r).toBe(1);
      expect(h.bad_signature_count, r).toBe(0);
      expect(h.needs_attention, r).toBe(false);
    }
  });

  it('records a stale timestamp without alarming: it is genuinely ambiguous', async () => {
    // Clock drift, a replayed capture, or a stranger with an old timestamp.
    // Real information, but not evidence of anything on its own.
    const m = await load();
    m.recordWebhookRejected('timestamp_outside_tolerance');
    const h = m.webhookHealth();
    expect(h.stale_timestamp_count).toBe(1);
    expect(h.bad_signature_count).toBe(0);
    expect(h.needs_attention).toBe(false);
  });

  it('alarms only on a well-formed in-window signature that did not match', async () => {
    const m = await load();
    m.recordWebhookRejected('no_matching_signature');
    const h = m.webhookHealth();
    expect(h.bad_signature_count).toBe(1);
    expect(h.needs_attention).toBe(true);
  });

  it('does not claim a customer was charged, because it cannot know that', async () => {
    // A forged rejection and a real one are indistinguishable without the
    // secret. Overstating trains the reader to discount the alert just as
    // surely as understating does.
    const m = await load();
    m.recordWebhookRejected('no_matching_signature');
    const note = m.webhookHealth().note;
    expect(note).toMatch(/STRIPE DELIVERY LOG/i);
    expect(note).toMatch(/forge/i);
    expect(note).not.toMatch(/certainly our secret/i);
  });

  it('survives an unwritable data dir without throwing', async () => {
    vi.resetModules();
    process.env.DATA_DIR = '/proc/nonexistent-cannot-create';
    const m = await import('../src/webhookHealth.js');
    expect(() => m.initWebhookHealth()).not.toThrow();
    expect(() => m.recordWebhookVerified()).not.toThrow();
    expect(m.webhookHealth().status).toBe('healthy');
  });
});

describe('acknowledging an incident', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  /**
   * Without this the alert is permanent, which is the reconciler bug wearing a
   * different hat: /stats spent most of a day insisting funds had been swept.
   * A sticky alarm with no off switch is not a stricter control, it is a
   * broken one.
   */
  it('clears a live incident so the alarm can be switched off', async () => {
    const m = await load();
    m.recordWebhookRejected('no_matching_signature');
    expect(m.webhookHealth().needs_attention).toBe(true);

    const r = m.acknowledgeWebhookIncident(new Date('2026-08-21T21:00:00Z'));
    expect(r.cleared).toBe(1);

    const h = m.webhookHealth();
    expect(h.needs_attention).toBe(false);
    expect(h.bad_signature_count).toBe(0);
  });

  it('keeps the history rather than deleting it', async () => {
    // The count moves to a running total. Someone auditing later must still be
    // able to see that deliveries were once turned away.
    const m = await load();
    m.recordWebhookRejected('no_matching_signature');
    m.recordWebhookRejected('no_matching_signature');
    m.acknowledgeWebhookIncident(new Date('2026-08-21T21:00:00Z'));
    const h = m.webhookHealth();
    expect(h.acknowledged_total).toBe(2);
    expect(h.last_acknowledged_at).toBe('2026-08-21T21:00:00.000Z');
    expect(h.last_reject_reason).toBe('no_matching_signature');
  });

  it('does not auto-clear on a later success', async () => {
    // A success proves the secret is right NOW. It says nothing about whether
    // the buyers turned away in the bad window ever got their passes, so it
    // must not erase the record while someone is still owed something.
    const m = await load();
    m.recordWebhookRejected('no_matching_signature');
    m.recordWebhookVerified();
    expect(m.webhookHealth().needs_attention).toBe(true);
  });

  it('re-raises if a signed delivery is rejected after an acknowledgement', async () => {
    const m = await load();
    m.recordWebhookRejected('no_matching_signature');
    m.acknowledgeWebhookIncident();
    expect(m.webhookHealth().needs_attention).toBe(false);
    m.recordWebhookRejected('no_matching_signature');
    expect(m.webhookHealth().status).toBe('REJECTING_SIGNED_DELIVERIES');
  });

  it('is a no-op when there is nothing to clear', async () => {
    const m = await load();
    expect(m.acknowledgeWebhookIncident().cleared).toBe(0);
    expect(m.webhookHealth().status).toBe('never_exercised');
  });
});

describe('our own probes must label themselves', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  /**
   * Written after I fired a forged signature at production to verify this very
   * instrument, raised a real incident, and a teammate spent time running it
   * down mid-way through answering the founder — nearly attributing it to a
   * third agent whose commits matched the minute. A deliberate test and a
   * genuine event must not be indistinguishable after the fact.
   */
  it('never alarms on a rejection carrying our internal marker', async () => {
    const m = await load();
    m.recordWebhookRejected('no_matching_signature', { internal: true });
    const h = m.webhookHealth();
    expect(h.internal_probe_count).toBe(1);
    expect(h.bad_signature_count).toBe(0);
    expect(h.needs_attention).toBe(false);
    expect(h.status).toBe('never_exercised');
  });

  it('still alarms on the same reason WITHOUT the marker', async () => {
    // Forgetting the marker errs toward alarm, never toward silence — the same
    // failure direction internal.ts chose, and for the same reason.
    const m = await load();
    m.recordWebhookRejected('no_matching_signature');
    expect(m.webhookHealth().needs_attention).toBe(true);
  });

  it('keeps our probes out of the stranger-probe count too', async () => {
    // Separate bucket, so "how often do strangers poke this endpoint" stays
    // answerable and is not inflated by our own testing.
    const m = await load();
    m.recordWebhookRejected('missing_signature_header', { internal: true });
    const h = m.webhookHealth();
    expect(h.internal_probe_count).toBe(1);
    expect(h.probe_count).toBe(0);
  });
});
