import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Whether the Stripe card rail is actually working, and whether we know.
 *
 * WHY THIS EXISTS. A rejected webhook signature is not a logging matter, it is
 * a customer who paid and received nothing. The chain of consequences is exact:
 * Stripe charges the card, delivers the event, we reject it as unsigned-by-us,
 * `recordDelivery` never runs, no pass is minted, and the buyer's success page
 * tells them "wait a few seconds and reload" — which is a lie, because no
 * amount of waiting will produce a pass. This is precisely the
 * money-taken-no-service failure the x402 side was designed to avoid, sitting
 * unguarded on the other rail.
 *
 * Until now the only trace was one `console.error` in a log nobody watches.
 *
 * THE DISTINCTION THAT CARRIES THE SIGNAL. Not all rejections mean the same
 * thing, and treating them alike would bury the one that matters:
 *
 *  - `missing_signature_header` — no Stripe-Signature at all. A scanner, a
 *    curl, or one of us probing the endpoint. Benign. Real Stripe deliveries
 *    ALWAYS carry the header.
 *  - anything else — the header was present and we could not match it. That is
 *    a genuinely signed delivery we are turning away, and the overwhelmingly
 *    likely cause is that our secret does not match the one Stripe is signing
 *    with. Someone is probably out of pocket right now.
 *
 * NEVER_EXERCISED IS NOT HEALTHY. The third state is the one this codebase has
 * repeatedly failed to name: a rotated secret that no delivery has ever tested
 * is unverified, not working. Reporting it as healthy would be the same defect
 * as a risk check that emits no flag when it could not run, and as a reconciler
 * that reads `reconciled` because it compared a figure against itself. Silence
 * is not a pass.
 */

export type WebhookStatus = 'never_exercised' | 'healthy' | 'REJECTING_SIGNED_DELIVERIES';

export interface WebhookHealth {
  status: WebhookStatus;
  /** Last time a delivery verified. Null means the secret has never been proven. */
  last_verified_at: string | null;
  last_rejected_at: string | null;
  last_reject_reason: string | null;
  verified_count: number;
  /** Signed deliveries we turned away. Each one is a probable lost sale. */
  bad_signature_count: number;
  /** Unsigned hits: scanners and our own probes. Carries no signal. */
  probe_count: number;
  /** When a human last cleared an incident, so a live alarm can be dismissed. */
  last_acknowledged_at: string | null;
  /** Rejections cleared by acknowledgement over all time. Never reset. */
  acknowledged_total: number;
  /** True when a human needs to act. */
  needs_attention: boolean;
  note: string;
}

interface Stored {
  last_verified_at: string | null;
  last_rejected_at: string | null;
  last_reject_reason: string | null;
  verified_count: number;
  bad_signature_count: number;
  probe_count: number;
  /** When a human last confirmed they had dealt with an incident. */
  last_acknowledged_at: string | null;
  /** Running total of rejections cleared by acknowledgement, never reset. */
  acknowledged_total: number;
}

const EMPTY: Stored = {
  last_verified_at: null,
  last_rejected_at: null,
  last_reject_reason: null,
  verified_count: 0,
  bad_signature_count: 0,
  probe_count: 0,
  last_acknowledged_at: null,
  acknowledged_total: 0,
};

const dataDir = process.env.DATA_DIR ?? './data';
const statePath = join(dataDir, 'webhook-health.json');

let state: Stored = { ...EMPTY };
let persistent = false;

export function initWebhookHealth(): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    if (existsSync(statePath)) {
      state = { ...EMPTY, ...(JSON.parse(readFileSync(statePath, 'utf8')) as Partial<Stored>) };
    }
    persistent = true;
  } catch (err) {
    // In-memory only means a restart forgets that a delivery was rejected,
    // which under-reports rather than falsely reassures. Say so either way.
    console.error('webhook health state unavailable, counting in memory only:', err);
  }
}

function persist(): void {
  if (!persistent) return;
  try {
    const tmp = `${statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, statePath);
  } catch (err) {
    persistent = false;
    console.error('webhook health write failed, continuing in memory:', err);
  }
}

/** A delivery whose signature we verified. The only thing that proves the secret. */
export function recordWebhookVerified(now = new Date()): void {
  state.verified_count += 1;
  state.last_verified_at = now.toISOString();
  persist();
}

/**
 * A delivery we turned away.
 *
 * The reason decides whether this is noise or an incident, so it is required
 * rather than optional — a caller that cannot say why it rejected something
 * should not be able to record it as harmless by omission.
 */
export function recordWebhookRejected(reason: string, now = new Date()): void {
  state.last_rejected_at = now.toISOString();
  state.last_reject_reason = reason;
  if (reason === 'missing_signature_header') {
    state.probe_count += 1;
  } else {
    state.bad_signature_count += 1;
    console.error(
      `[stripe] SIGNED DELIVERY REJECTED (${reason}). A customer may have been charged ` +
        'with no pass minted. Check STRIPE_WEBHOOK_SECRET against the signing secret in ' +
        'the Stripe dashboard; Stripe retries for ~3 days, so fixing the secret should ' +
        'still deliver the pass.',
    );
  }
  persist();
}

/**
 * A human has dealt with the incident: clear it.
 *
 * WHY THIS HAS TO EXIST. Without it the incident is permanent, and a permanent
 * alarm is one nobody reads on the day it is right — the precise defect found
 * in the reconciler hours before this file was written, where /stats reported a
 * drain that never happened for most of a day. Building a sticky alert with no
 * way to clear it would have reproduced that bug in a new place while the fix
 * for the old one was still warm.
 *
 * Deliberately NOT automatic on the next successful delivery. A success only
 * proves the secret is right NOW; it says nothing about whether the buyers who
 * were turned away in the bad window ever got their passes. Clearing on success
 * would erase the record exactly when someone is still owed something. So it
 * takes a person, and the acknowledgement is itself recorded — the count is
 * moved to a running total rather than deleted, so the history survives.
 */
export function acknowledgeWebhookIncident(now = new Date()): {
  cleared: number;
  acknowledged_at: string;
} {
  const cleared = state.bad_signature_count;
  state.acknowledged_total += cleared;
  state.bad_signature_count = 0;
  state.last_acknowledged_at = now.toISOString();
  persist();
  return { cleared, acknowledged_at: state.last_acknowledged_at };
}

export function webhookHealth(): WebhookHealth {
  const base = {
    last_verified_at: state.last_verified_at,
    last_rejected_at: state.last_rejected_at,
    last_reject_reason: state.last_reject_reason,
    verified_count: state.verified_count,
    bad_signature_count: state.bad_signature_count,
    probe_count: state.probe_count,
    last_acknowledged_at: state.last_acknowledged_at,
    acknowledged_total: state.acknowledged_total,
  };

  if (state.bad_signature_count > 0) {
    return {
      ...base,
      status: 'REJECTING_SIGNED_DELIVERIES',
      needs_attention: true,
      note:
        `${state.bad_signature_count} signed Stripe deliver${state.bad_signature_count === 1 ? 'y was' : 'ies were'} ` +
        `rejected (last: ${state.last_reject_reason}). Real deliveries are always signed, so this is almost ` +
        'certainly our secret disagreeing with Stripe. Anyone who paid by card in that window was charged ' +
        'and got no pass. Stripe retries for about three days: fix STRIPE_WEBHOOK_SECRET and the passes ' +
        'should still land.',
    };
  }

  if (state.verified_count === 0) {
    return {
      ...base,
      status: 'never_exercised',
      // Not an alert. It is the honest absence of evidence, and it stops
      // anyone reading quiet as confirmation.
      needs_attention: false,
      note:
        'No Stripe webhook has ever verified against the current secret, so the card rail is UNPROVEN — ' +
        'not broken, not working, untested. The first real purchase is also the test. Until then, an ' +
        'x402 sale is the one with a demonstrated end-to-end path.',
    };
  }

  return {
    ...base,
    status: 'healthy',
    needs_attention: false,
    note: `Card rail proven: ${state.verified_count} signed deliver${state.verified_count === 1 ? 'y has' : 'ies have'} verified, last at ${state.last_verified_at}.`,
  };
}

/** Testing seam: reset in-memory counters. */
export function __resetWebhookHealth(): void {
  state = { ...EMPTY };
  persistent = false;
}
