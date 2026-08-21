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
 * THE DISTINCTION THAT CARRIES THE SIGNAL. `/stripe/webhook` is public by
 * necessity, so ANY stranger with curl can produce a rejection. The
 * classification therefore has to ask not "was this rejected" but "is this a
 * shape only a real Stripe delivery could have produced":
 *
 *  - `missing_signature_header`, `missing_timestamp`, `missing_v1_signature` —
 *    the header was absent or not shaped like Stripe's. A real Stripe delivery
 *    NEVER produces these; they are scanners, our own probes, or someone
 *    poking. Noise, and counted as such.
 *  - `timestamp_outside_tolerance` — well-formed but old. Genuinely ambiguous:
 *    clock drift, a replayed capture, or a stranger with an old timestamp. Its
 *    own counter, deliberately NOT an alert.
 *  - `no_matching_signature` — well-formed header, timestamp inside the window,
 *    signature does not match. The only shape consistent with "Stripe sent it
 *    and our secret is wrong". This is the signal.
 *
 * WHAT THE ALERT CAN AND CANNOT CLAIM. Even `no_matching_signature` is forgeable
 * by anyone willing to send a plausible timestamp — distinguishing a forged
 * rejection from a real one is impossible without the secret, by construction.
 * So the alert says "something claiming to be Stripe was turned away, go read
 * the Stripe delivery log", NOT "a customer was charged and got nothing". The
 * first version asserted the second, which is a claim it cannot support; an
 * alert that overstates trains its reader to discount it just as surely as one
 * that understates, only more slowly.
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
  /**
   * Well-formed, in-window signatures that did not match ours. The shape of a
   * real delivery being refused — and equally the shape a stranger can forge,
   * so this prompts a look at Stripe's delivery log rather than asserting a
   * lost sale on its own.
   */
  bad_signature_count: number;
  /** Malformed or absent signatures: scanners and probes. Carries no signal. */
  probe_count: number;
  /** Well-formed but stale timestamps. Ambiguous, so recorded not alarmed. */
  stale_timestamp_count: number;
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
  stale_timestamp_count: number;
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
  stale_timestamp_count: 0,
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

/** Shapes a real Stripe delivery can never produce. Anyone can send these. */
const PROBE_REASONS = new Set([
  'missing_signature_header',
  'missing_timestamp',
  'missing_v1_signature',
]);

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

  if (PROBE_REASONS.has(reason)) {
    state.probe_count += 1;
  } else if (reason === 'timestamp_outside_tolerance') {
    // Well-formed but stale. Clock drift, a replay, or a stranger reusing an
    // old capture — no way to tell, so it is recorded and not alarmed on.
    state.stale_timestamp_count += 1;
  } else {
    state.bad_signature_count += 1;
    console.error(
      `[stripe] webhook rejected with ${reason}: a well-formed, in-window signature that ` +
        'did not match. Consistent with our secret disagreeing with Stripe, and also ' +
        'forgeable by anyone. CHECK THE STRIPE DELIVERY LOG: if Stripe shows failed ' +
        'deliveries, fix STRIPE_WEBHOOK_SECRET — retries run for ~3 days, so the passes ' +
        'should still land. If Stripe shows none, this was a stranger and can be acked.',
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
    stale_timestamp_count: state.stale_timestamp_count,
    last_acknowledged_at: state.last_acknowledged_at,
    acknowledged_total: state.acknowledged_total,
  };

  if (state.bad_signature_count > 0) {
    return {
      ...base,
      status: 'REJECTING_SIGNED_DELIVERIES',
      needs_attention: true,
      note:
        `${state.bad_signature_count} request${state.bad_signature_count === 1 ? '' : 's'} presented a well-formed, ` +
        'in-window Stripe signature that did not match our secret. That is the shape of a real delivery we are ' +
        'turning away — and also the shape a stranger can forge, which cannot be told apart without the secret. ' +
        'GO READ THE STRIPE DELIVERY LOG. Failed deliveries there mean STRIPE_WEBHOOK_SECRET is wrong and buyers ' +
        'were charged without receiving a pass; retries run about three days, so fixing it should still deliver ' +
        'them. No failed deliveries there means this was noise, and it can be acknowledged.',
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
