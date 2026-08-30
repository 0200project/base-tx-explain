/**
 * Per-engagement x402 resources: a service sale (a diagnosis, an integration) paid
 * at a CUSTOM amount over the same challenge -> pay -> on-chain-settlement flow
 * the product uses. The settlement transaction IS the invoice — the same
 * cryptographic receipt an external payer self-verified, priced to a quote instead of a
 * per-call rate.
 *
 * WHY A COMMITTED REGISTRY rather than an open "pay any amount" endpoint:
 *  - it is a payment endpoint, NOT a service promise (no SLA surface). Each
 *    entry is one agreed deal at one agreed price; a buyer cannot invent an
 *    amount, and we cannot accidentally quote one.
 *  - only WE can define an engagement. Adding one is a one-line commit + deploy,
 *    which is the right friction for a $500-2500 sale that closes by hand a few
 *    times a week, not a thing that needs a runtime admin surface.
 *  - the price is the payment requirement verbatim (see rest.ts), so what the
 *    buyer is asked to sign is exactly what was quoted, with no server-side
 *    arithmetic between the quote and the challenge.
 *  - the challenge is reachable by anyone who guesses the slug, so an id or a
 *    title must NEVER carry the customer's identity: use an OPAQUE slug
 *    (e.g. `pa-7f3c91`, not a buyer-named slug) and keep the buyer's name out of
 *    the title. The unpaid wire already omits title and summary; opaque slugs
 *    keep the URL itself from naming who bought.
 *  - once paid, an engagement is CLOSED: its route refuses a second charge and
 *    answers like an unknown id (see settledEngagements.ts), because the buyers
 *    are companies whose finance systems retry by design and a double charge is
 *    a terrible first impression from a payments vendor.
 *
 * ATTRIBUTION: an engagement settlement books like any sale and is then
 * attributed the normal way — a real buyer's payment is customer revenue; the
 * founder's own marked acceptance test of the `demo` entry is a self-test, ruled
 * non-revenue exactly like the $9 buy_pass test. The endpoint does not decide
 * whose money it is; the existing attribution path does.
 */

export interface Engagement {
  /** URL slug in /engagement/<id>. Lowercase, digits, hyphens. For a real deal use an OPAQUE slug (pa-7f3c91), NEVER the customer's name. */
  id: string;
  /** The quoted price in whole USD. The payment challenge asks for exactly this. */
  amountUsd: number;
  /** Shown on the PAID receipt only (kept off the unpaid challenge). Never the customer's name — the reader already knows who they are. */
  title: string;
  /** One line naming what the buyer is paying for. Receipt-only like the title; never customer-identifying. */
  summary: string;
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/**
 * The live engagements. Add one line per closed deal, then deploy.
 *
 * `demo` is the standing acceptance-test target: a $1 proof the founder can pay
 * spend-wallet -> payout-wallet to demonstrate the whole flow (marked
 * non-revenue), and the artifact a pitch can point at — "here is exactly what
 * paying us looks like, receipt and all." Real engagements
 * are added when they close, at their quoted amount.
 */
export const ENGAGEMENTS: Engagement[] = [
  {
    id: 'demo',
    amountUsd: 1,
    title: '0200project — engagement payment demo',
    summary:
      'A $1 proof of the engagement path: a challenge naming this engagement, paid over x402, settled on-chain. The settlement transaction is the receipt.',
  },
];

/** The engagement for a slug, or undefined for an unknown or malformed id. */
export function engagementById(id: string | undefined): Engagement | undefined {
  if (!id || !SLUG.test(id)) return undefined;
  return ENGAGEMENTS.find((e) => e.id === id);
}

/** Every id validates as a slug and is unique — checked at import so a bad entry fails loudly, not at first request. */
for (const e of ENGAGEMENTS) {
  if (!SLUG.test(e.id)) throw new Error(`engagement id is not a valid slug: ${JSON.stringify(e.id)}`);
  if (!(e.amountUsd > 0)) throw new Error(`engagement ${e.id} has a non-positive amount`);
}
if (new Set(ENGAGEMENTS.map((e) => e.id)).size !== ENGAGEMENTS.length) {
  throw new Error('duplicate engagement id');
}
