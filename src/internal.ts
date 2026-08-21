import { timingSafeEqual } from 'node:crypto';

/**
 * Marks traffic as our own, so the scoreboard can tell us apart from strangers.
 *
 * WHY THIS EXISTS
 *
 * Our own curls, test scripts and deploy checks are currently indistinguishable
 * from a customer's in the ledger. Three times in twelve hours a promising
 * number turned out to be one of us: a $9 Stripe settlement that was a
 * test-mode purchase, a metric that counted payment attempts as revenue, and a
 * new unique client that was a curl I ran to check a header. Each was caught
 * only because someone asked a human before reporting it, which makes the
 * scoreboard depend on somebody remembering what they ran an hour ago.
 *
 * THE FAILURE DIRECTION IS THE WHOLE DESIGN
 *
 * Forgetting the header makes our own call look EXTERNAL, never the reverse.
 * That errs toward suspicion — we might undercount ourselves and investigate a
 * number that turns out to be us — rather than toward a false milestone, where
 * a real stranger is dismissed as internal and the one signal this project is
 * waiting for gets thrown away. The costs are wildly asymmetric, so the bias
 * must point at the cheap mistake.
 *
 * WHY A SECRET RATHER THAN A FIXED HEADER
 *
 * A known name with a known value could be mimicked by an external party
 * probing the API, deliberately or by accident — and at least one party who
 * engages with us reads our wire format byte by byte as a matter of course.
 * Someone stumbling into the marker would be counted as internal, which is
 * exactly the failure the design is built to avoid. Deriving the value from an
 * env var keeps the forget-it-looks-external property while closing that.
 *
 * NOT A SECURITY CONTROL. It grants no access and gates nothing. It only
 * affects how a call is labelled in our own statistics, so the worst case if it
 * leaked is a miscounted row.
 */

const HEADER = 'x-btx-internal';

/** Empty when unset, which disables marking entirely rather than matching ''. */
const MARKER = process.env.INTERNAL_MARKER ?? '';

/**
 * Was this request made by us?
 *
 * Constant-time comparison for the same reason any secret comparison is: the
 * value is low-stakes but there is no reason to leak it a byte at a time, and
 * the cost is nil.
 */
export function isInternalRequest(headers: Record<string, unknown>): boolean {
  if (!MARKER) return false;
  const presented = headers[HEADER];
  if (typeof presented !== 'string' || presented.length === 0) return false;

  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(MARKER, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Whether marking is configured at all, so a dashboard can say so honestly. */
export function internalMarkingEnabled(): boolean {
  return MARKER.length > 0;
}

/**
 * The header a caller must send, for our own scripts to use.
 *
 * Exposed as a name only. The value lives in the environment and is never
 * returned by any endpoint, because a marker an endpoint hands out is a marker
 * anyone can wear.
 */
export const INTERNAL_HEADER_NAME = HEADER;
