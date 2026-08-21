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
    expect(h.note).toMatch(/charged/i);
    expect(h.note).toMatch(/retries/i);
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

  it('counts every rejection reason except a missing header as a bad signature', async () => {
    const m = await load();
    for (const r of ['missing_timestamp', 'missing_v1_signature', 'timestamp_outside_tolerance', 'no_matching_signature']) {
      const fresh = await load();
      fresh.recordWebhookRejected(r);
      expect(fresh.webhookHealth().bad_signature_count, r).toBe(1);
    }
    m.recordWebhookRejected('missing_signature_header');
    expect(m.webhookHealth().bad_signature_count).toBe(0);
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
