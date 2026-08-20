/**
 * Apify pay-per-event billing, active only when running as an Apify actor.
 *
 * The SDK is loaded via dynamic import gated on APIFY_IS_AT_HOME, so Fly and
 * self-hosted deployments never load it and their boot path is unchanged.
 * Actor.charge() never throws for payment problems: outside a PPE-priced run
 * it returns {chargedCount: 0, eventChargeLimitReached: false}, which we
 * treat as "proceed free" - that keeps dev runs and the pre-monetization
 * window harmless. Marketplace billing (PPE) and the x402 rail are mutually
 * exclusive by deployment: the Apify build runs PAYMENT_MODE=none.
 */

const ON_APIFY = Boolean(process.env.APIFY_IS_AT_HOME);
const EVENT_NAME = 'explain-transaction';

type ApifyActor = {
  init(): Promise<void>;
  charge(opts: { eventName: string; count?: number }): Promise<{
    chargedCount: number;
    eventChargeLimitReached: boolean;
  }>;
};

let actor: ApifyActor | null = null;

/** Initialize the Apify SDK when running on the platform; no-op elsewhere. */
export async function initApifyBilling(): Promise<void> {
  if (!ON_APIFY) return;
  try {
    const mod = (await import('apify')) as unknown as { Actor: ApifyActor };
    await mod.Actor.init();
    actor = mod.Actor;
    console.log('apify billing: initialized (pay-per-event, event:', EVENT_NAME, ')');
  } catch (err) {
    // Billing must never take the tool down; the run proceeds unbilled and loudly.
    console.error('apify billing: init failed, calls will not be charged:', err);
  }
}

/**
 * Charge one SUCCESSFUL tool call - callers invoke this only after a clean
 * decode. PPE charges are not refundable, so errors (ours or the user's) are
 * never billed; that matches the x402 rail, where settlement is cancelled on
 * any error result. If the caller's spend limit is reached, the decode we
 * just served goes unbilled (the platform aborts their run afterwards) - one
 * free response is the right side to err on.
 */
export async function chargeApifyCall(): Promise<void> {
  if (!actor) return;
  try {
    const result = await actor.charge({ eventName: EVENT_NAME });
    if (result.chargedCount === 0 && result.eventChargeLimitReached) {
      console.warn('apify billing: caller charge limit reached; this response goes unbilled and the platform will end the run');
    }
  } catch (err) {
    console.error('apify billing: charge failed after a served decode:', err);
  }
}

export const APIFY_BILLING_ACTIVE = ON_APIFY;
