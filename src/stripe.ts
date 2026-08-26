import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Stripe card checkout: webhook receipt, and token delivery after payment.
 *
 * WHAT THIS DELIBERATELY DOES NOT HOLD
 *
 * No Stripe secret key. Products and payment links are created in the
 * dashboard, so nothing here needs API access, and the only secret the server
 * carries is the webhook signing secret. That secret verifies signatures and
 * cannot move money: it cannot refund, charge, or read a customer. Creating
 * Checkout Sessions over the API would have required a key that can do all
 * three, and giving that up was not worth the flexibility.
 *
 * The signing secret is not harmless, though, and the asymmetry is worth
 * naming: anyone holding it can FORGE a "payment succeeded" event and mint
 * themselves a pass. It buys product, not money — which is exactly why
 * verification below is strict and why the secret never appears in a log line.
 *
 * WHY THE WEBHOOK IS AUTHORITATIVE AND THE REDIRECT IS NOT
 *
 * Stripe sends the buyer back to a success URL carrying a session id. That
 * redirect is a claim made by a browser, not proof of anything: a session id is
 * a string, and minting on one would hand a pass to anyone who produced a
 * plausible-looking value. So the webhook mints, and the success page only
 * LOOKS UP what the webhook already minted. A forged session id finds nothing.
 */

/** How long a paid session can still retrieve its token. */
const RETRIEVAL_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Stripe rejects timestamps outside this window to stop replayed webhooks. */
const SIGNATURE_TOLERANCE_S = 300;

export interface DeliveredPass {
  token: string;
  expires_at: string;
  call_cap: number;
  /** 'pass' for the one-time product, 'subscription' for the recurring one. */
  kind: 'pass' | 'subscription';
  /** Stripe subscription id, when this came from the recurring product. */
  subscription_id?: string;
  delivered_at: number;
}

/**
 * Session id -> the pass minted for it.
 *
 * Holds the token in PLAINTEXT, which the pass store deliberately does not, and
 * that is a real if bounded weakening. The alternative is worse: a buyer who
 * closes the tab loses a thing they paid for, and with a card behind it that is
 * not a hard lesson, it is a chargeback plus a dispute mark. Two days is long
 * enough to come back for it and short enough that this is not a token
 * database.
 *
 * PERSISTED, because "in memory only" stopped being acceptable the day deploys
 * became hourly. The original tradeoff — "a restart drops it, so a buyer
 * mid-window would have to contact us" — was written when restarts were rare.
 * We then deployed eleven-plus times in one day, which turned the coded
 * 48-hour retrieval guarantee into "until the next deploy," measured in
 * minutes. The founder's own $9 pass proved it: unreachable through his
 * success URL 11.5 hours into a 48-hour window, while the page told him to
 * "wait a few seconds and reload" — a promise that could never come true.
 *
 * The original author's reasoning was sound for its facts and is kept above;
 * the facts changed. Same pattern as webhookHealth and waitingBuyers: load on
 * boot, atomic tmp+rename writes, degrade to memory-only with a loud line
 * rather than ever taking down the payment path.
 */
const bySession = new Map<string, DeliveredPass>();
/** Subscription id -> session id, so renewals and cancellations find the pass. */
const sessionBySubscription = new Map<string, string>();

const dataDir = process.env.DATA_DIR ?? './data';
const deliveryPath = join(dataDir, 'stripe-deliveries.json');
let persistent = false;

export function initStripeDeliveries(now = Date.now()): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    if (existsSync(deliveryPath)) {
      const raw = JSON.parse(readFileSync(deliveryPath, 'utf8')) as Record<string, DeliveredPass>;
      for (const [id, p] of Object.entries(raw)) {
        if (!p || typeof p.delivered_at !== 'number' || typeof p.token !== 'string') continue;
        if (now - p.delivered_at > RETRIEVAL_WINDOW_MS) continue; // aged out honestly
        bySession.set(id, p);
        if (p.subscription_id) sessionBySubscription.set(p.subscription_id, id);
      }
    }
    persistent = true;
    console.log(`stripe deliveries: ${deliveryPath} (${bySession.size} retrievable)`);
  } catch (err) {
    // Memory-only under-serves (a restart forgets deliveries) rather than
    // falsely reassuring — but say so, every boot, since silence here is how
    // the original gap survived three days.
    console.error('stripe delivery store unavailable, retrieval window is until-next-restart:', err);
  }
}

function flushDeliveries(): void {
  if (!persistent) return;
  try {
    const tmp = `${deliveryPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(bySession)));
    renameSync(tmp, deliveryPath);
  } catch (err) {
    persistent = false;
    console.error('stripe delivery write failed, continuing in memory:', err);
  }
}

function prune(now: number): void {
  for (const [id, p] of bySession) {
    if (now - p.delivered_at > RETRIEVAL_WINDOW_MS) {
      bySession.delete(id);
      if (p.subscription_id) sessionBySubscription.delete(p.subscription_id);
    }
  }
}

/**
 * Verify a Stripe webhook signature.
 *
 * Hand-rolled rather than pulled from the SDK because the SDK exists to wrap an
 * API we deliberately do not call, and this is the one piece of it we need. The
 * scheme is documented and small: the signed payload is `timestamp.rawBody`,
 * HMAC-SHA256 with the endpoint secret, compared against the v1 values in the
 * Stripe-Signature header.
 *
 * Three things this must get right, each of which is a real attack if missed:
 * compare in constant time so the signature cannot be guessed byte by byte;
 * enforce the timestamp window so a captured webhook cannot be replayed later;
 * and verify against the RAW body, because re-serialising parsed JSON changes
 * bytes and would fail every legitimate event.
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): { ok: true } | { ok: false; reason: string } {
  if (!header) return { ok: false, reason: 'missing_signature_header' };

  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.trim().split('=');
    if (k === 't' && v) timestamp = v;
    if (k === 'v1' && v) signatures.push(v);
  }
  if (!timestamp) return { ok: false, reason: 'missing_timestamp' };
  if (signatures.length === 0) return { ok: false, reason: 'missing_v1_signature' };

  const age = Math.abs(nowSeconds - Number.parseInt(timestamp, 10));
  if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_S) {
    return { ok: false, reason: 'timestamp_outside_tolerance' };
  }

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  for (const candidate of signatures) {
    const candidateBuf = Buffer.from(candidate, 'utf8');
    if (candidateBuf.length !== expectedBuf.length) continue;
    if (timingSafeEqual(candidateBuf, expectedBuf)) return { ok: true };
  }
  return { ok: false, reason: 'no_matching_signature' };
}

export interface StripeEvent {
  id?: string;
  type?: string;
  /**
   * False for test-mode events. Load-bearing: a test purchase must mint a
   * working pass (that is what testing the flow means) while booking no
   * revenue, or the ledger reports money that does not exist.
   */
  livemode?: boolean;
  data?: { object?: Record<string, unknown> };
}

/** Events already handled, so a redelivery does not mint a second pass. */
const handledEvents = new Set<string>();
const HANDLED_CAP = 5_000;

/**
 * Has this event already been processed?
 *
 * Stripe retries until it gets a 2xx, and a retry after a slow response is
 * normal rather than exceptional. Without this, one purchase that happened to
 * be slow would mint several passes and the buyer would be charged once for
 * each — the kind of bug that is invisible to us and obvious to them.
 */
export function alreadyHandled(eventId: string | undefined): boolean {
  if (!eventId) return false;
  if (handledEvents.has(eventId)) return true;
  handledEvents.add(eventId);
  if (handledEvents.size > HANDLED_CAP) {
    // Oldest-first eviction; insertion order is iteration order for a Set.
    const oldest = handledEvents.values().next().value;
    if (oldest) handledEvents.delete(oldest);
  }
  return false;
}

/** Record a minted pass against the session that paid for it. */
export function recordDelivery(sessionId: string, pass: DeliveredPass): void {
  prune(Date.now());
  bySession.set(sessionId, pass);
  if (pass.subscription_id) sessionBySubscription.set(pass.subscription_id, sessionId);
  flushDeliveries();
}

/**
 * The pass minted for a session, if the webhook has already recorded one.
 *
 * Returns null both for an unknown session and for one whose window has closed,
 * and the caller must not distinguish them to the buyer: telling a stranger
 * "that session exists but expired" confirms a guessed id was real.
 */
export function passForSession(sessionId: string): DeliveredPass | null {
  prune(Date.now());
  return bySession.get(sessionId) ?? null;
}

/** The pass belonging to a subscription, for renewal and cancellation events. */
export function passForSubscription(subscriptionId: string): DeliveredPass | null {
  const sessionId = sessionBySubscription.get(subscriptionId);
  return sessionId ? (bySession.get(sessionId) ?? null) : null;
}

/**
 * A Stripe checkout session id, or null.
 *
 * Strict because this value arrives in a URL from a stranger and is then used
 * as a map key. Stripe's own format is `cs_` plus base58-ish characters; a
 * length cap keeps a hostile value from becoming a large key.
 */
export function validSessionId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return /^cs_[A-Za-z0-9_]{8,120}$/.test(raw) ? raw : null;
}

/** Which product a completed session bought, judged by Stripe's own mode. */
export function sessionKind(session: Record<string, unknown>): 'pass' | 'subscription' {
  return session.mode === 'subscription' ? 'subscription' : 'pass';
}

/**
 * Was this checkout OUR OWN, rather than a customer's?
 *
 * The founder is expected to buy a $9 pass himself to prove the card rail end
 * to end. That purchase is `livemode: true`, so it books as revenue and
 * `/healthz` — public and unauthenticated — would report
 * `revenue_from_customers_usd: 9.00` on the night that number is being watched.
 * It would read as the first real sale.
 *
 * The obvious fix, pre-logging it in KNOWN_NON_REVENUE, is WRONG and was
 * correctly refused: an entry for money that has not arrived subtracts from a
 * total that does not contain it, producing the same arithmetic nonsense that
 * file exists to prevent. Pre-logging is only safe for entries already true.
 *
 * So the purchase labels ITSELF, the way our own HTTP traffic does. Set
 * SELF_PURCHASE_EMAIL to the address used at checkout and any settlement from
 * it is booked as arrived-but-not-earned, at the moment it happens, with no
 * hand-entry afterwards and no window where the public number is wrong.
 *
 * HONEST LIMIT, and it is the opposite of the internal marker's: forgetting to
 * set this makes a self-purchase look like a CUSTOMER, which is the flattering
 * direction. There is no way to invert it — requiring proof of being a stranger
 * would exclude every genuine sale. That is why the first booked customer
 * revenue also logs loudly (see index.ts): the milestone nobody should read
 * without checking is exactly the one this could get wrong.
 */
export function isSelfPurchase(obj: Record<string, unknown> | undefined): boolean {
  const expected = (process.env.SELF_PURCHASE_EMAIL ?? '').trim().toLowerCase();
  if (!expected) return false;
  const direct = typeof obj?.customer_email === 'string' ? obj.customer_email : '';
  const details = obj?.customer_details as { email?: unknown } | undefined;
  const nested = typeof details?.email === 'string' ? details.email : '';
  const seen = (direct || nested).trim().toLowerCase();
  return seen.length > 0 && seen === expected;
}
