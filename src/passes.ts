import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * $9 / 30-day passes, purchased over x402 (buy_pass tool) and presented on
 * calls via the X-BTX-Pass header or _meta["btx/pass"]. Bearer tokens by
 * design: no accounts, transferable, lost token = lost pass. The store keeps
 * only a hash of each token, so the file cannot be used to mint access.
 *
 * A valid pass forces charge=false at the same seam a remaining free call
 * does; it never touches the x402 verify/settle path. Caps make the $9
 * economics deliberate rather than exploitable: a volume cap for the month
 * and a per-pass rate limit so one pass cannot exhaust the public RPC quota
 * that free-tier users also depend on.
 */

export const PASS_PRICE_USD = '9';
export const PASS_DAYS = 30;
export const PASS_CALL_CAP = 10_000;
const PASS_RATE_PER_MINUTE = 60;

interface PassEntry {
  /** epoch ms */
  issued: number;
  /** epoch ms */
  expires: number;
  calls_used: number;
  /** payer address from settlement, for support/forensics only */
  payer?: string;
  /**
   * Per-pass call cap, defaulting to PASS_CALL_CAP when absent.
   *
   * Exists so a pass can be sized to its purpose. A self-issued internal pass
   * needs tens of calls, not ten thousand, and a credential's grant should match
   * the job rather than inherit the biggest number in the file.
   */
  cap?: number;
  /**
   * Self-issued by us, never sold. STRUCTURAL, not a label.
   *
   * A payer string reading "(NOT REVENUE)" describes an exclusion; this field
   * CAUSES one. `passSnapshot()` filters on this so `active_passes` cannot count
   * our own pass as a sale — the number means what its name says without anyone
   * remembering how it was produced.
   */
  internal?: boolean;
  /**
   * Set when a pass was activated WITHOUT a confirmed settlement (ambiguous or
   * missing settle response). Recorded on the entry, not just in the logs, so
   * an unpaid activation can be found by querying the store instead of grepping.
   */
  unconfirmed?: string;
  /**
   * A pass is usable only once its $9 payment is CONFIRMED settled.
   *
   * On the MCP rail the payment wrapper runs the handler before it settles and
   * hands the caller the handler's result either way, so a token string reaches
   * the client even when no money moved. Minting inactive closes that: the
   * client may hold the string, but it buys nothing until settlement confirms.
   * The REST rail does not need this — its middleware buffers the response and
   * discards the body when settlement fails, so the token never leaves the
   * server — and minting pending there would strand real payers with no hook to
   * activate them. Hence per-mint, not global.
   */
  active: boolean;
  /**
   * The EIP-3009 nonce this pass is waiting on, persisted so a pending pass can
   * still be identified after a restart.
   *
   * `pendingByNonce` is in-memory, so without this field the store structurally
   * could not express which nonce a restored pass belonged to — which is why
   * pending entries used to be dropped at boot.
   */
  nonce?: string;
  /**
   * Set at boot on a pending pass that could not survive the restart.
   *
   * The settlement hook that would have activated it lives in the process that
   * died, so it can never be activated by the normal path. It is retained
   * anyway: the payment may well have completed on chain after the process
   * went, leaving $9 in the payout wallet with no pass and no ledger entry, and
   * a customer holding a token. Deleting the entry left NEITHER END able to
   * find the other. Kept and listed, the loss is at least discoverable.
   */
  stranded?: string;
}

const dataDir = process.env.DATA_DIR ?? './data';
const statePath = join(dataDir, 'passes.json');

const passes = new Map<string, PassEntry>();
const rateWindows = new Map<string, { count: number; windowStart: number }>();
let persistent = false;

function hashToken(token: string): string {
  return createHash('sha256').update(`btx-pass:${token}`).digest('hex');
}

export function initPasses(): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    if (existsSync(statePath)) {
      const raw = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, PassEntry>;
      const now = Date.now();
      let stranded = 0;
      for (const [k, e] of Object.entries(raw)) {
        if (!e || typeof e.expires !== 'number' || e.expires <= now) continue;
        if (e.active === true) {
          passes.set(k, e);
          continue;
        }
        // A PENDING PASS CANNOT BE ACTIVATED ACROSS A RESTART — the settlement
        // hook that would have done it died with the old process. That much was
        // always true, and used to justify dropping the entry so nothing
        // unusable looked real.
        //
        // Dropping it silently is the part that was wrong. The payment may have
        // completed on chain AFTER the process went: the facilitator had already
        // broadcast, so $9 can land in the payout wallet with no pass, no ledger
        // entry, and a customer holding a token that answers "invalid". Deleting
        // the record left neither end able to find the other — the reconciler
        // sees an unattributable receipt, and support has nothing to search.
        //
        // Retained and marked instead. An entry that is visibly stranded is far
        // better than one nobody can discover.
        e.stranded = e.stranded ?? 'process restarted before settlement could activate this pass';
        passes.set(k, e);
        stranded++;
      }
      if (stranded > 0) {
        console.error(
          `[passes] ${stranded} PENDING PASS(ES) STRANDED BY A RESTART. Each may correspond to a ` +
            'payment that completed on chain with no pass issued and nothing in the ledger. ' +
            'Check the payout wallet against /passes/unconfirmed and settle with the buyer by hand.',
        );
      }
    }
    persistent = true;
    // COUNT THE TWO KINDS SEPARATELY. `passes.size` meant "active" only while
    // initPasses restored active entries alone; retaining stranded ones made
    // the word false. This line is the first thing someone debugging a lost $9
    // reads, so it was telling the one person who needed to hear "1 stranded"
    // that there was "1 active".
    const activeCount = [...passes.values()].filter((e) => e.active).length;
    const strandedCount = passes.size - activeCount;
    console.log(
      `passes: ${statePath} (${activeCount} active` +
        (strandedCount > 0 ? `, ${strandedCount} STRANDED awaiting a human` : '') +
        ')',
    );
  } catch (err) {
    // Never let a broken pass file take the service down. Degrading loses
    // paid passes on restart, which is the one unacceptable direction - so
    // flush() keeps trying and screams on every failure.
    console.error('pass store unavailable:', err);
  }
}

/** Atomic write: a torn pass file would strand paying customers. */
function flush(): void {
  try {
    const tmp = `${statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(passes)));
    renameSync(tmp, statePath);
    if (!persistent) {
      persistent = true;
      console.log('pass store recovered');
    }
  } catch (err) {
    persistent = false;
    console.error('PASS STORE WRITE FAILED - paid passes at risk on restart:', err);
  }
}

/**
 * Nonce of the payment authorization -> hashed token, for the brief window
 * between minting a pending pass and its settlement callback. In memory only:
 * a restart inside that window fails settle anyway, and pending passes are
 * dropped on load, so it fails safe.
 */
const pendingByNonce = new Map<string, { key: string; at: number }>();
const PENDING_TTL_MS = 10 * 60_000;

function reapPending(now: number): void {
  for (const [n, p] of pendingByNonce) {
    if (now - p.at > PENDING_TTL_MS) pendingByNonce.delete(n);
  }
}

/**
 * Mint a pass. `pending` withholds usability until `activatePass` confirms the
 * payment settled (MCP rail); omit it only where the caller cannot receive the
 * token unless settlement already succeeded (REST rail).
 */
/**
 * ⚠️ KNOWN HOLE, FILED NOT FIXED: WE CANNOT IDENTIFY MOST PASS BUYERS.
 *
 * Read from the production volume 2026-09-04: of four non-internal passes,
 * THREE carry no `payer` and no `nonce` at all. Nothing in our records names
 * who holds them.
 *
 * It is rail-specific rather than universal, and the distinction decides the fix:
 *
 *  - REST x402 (`mint: () => mintPass()`, index.ts): mints with NO argument, so
 *    no payer and no nonce are ever recorded. Identity is not merely unstored,
 *    it is UNRECOVERABLE.
 *  - Stripe (index.ts): passes `obj.customer`, which is null for guest
 *    checkout — so the field exists and is empty exactly when a stranger buys.
 *  - MCP x402 (index.ts): records a `nonce` but no payer. THIS ONE IS
 *    RECOVERABLE: the nonce is the EIP-3009 authorization nonce, and USDC emits
 *    `AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)`, so
 *    the payer can be read back off-chain from the nonce at any later date.
 *
 * WHY IT IS NOT FIXED HERE. The population is currently four calls on passes
 * whose only named payer is already booked as non-revenue, and renewal plumbing
 * ahead of demand costs more than the product earns. A documented hole beats a
 * build nobody needs yet — and beats a hole nobody wrote down.
 *
 * ⚠️ THE TRIGGER: THE FIRST PASS SALE TO SOMEONE WE CANNOT NAME. At that moment
 * this stops being theoretical, because a $9/30-day product whose holder we
 * cannot identify cannot be notified of a correction, cannot be asked to renew,
 * and expires silently — which reaches us as churn with no cause attached. It
 * compounds with the MCP signal hole: pass-state headers are invisible to MCP
 * callers, and `mcp_client` is the only shape that has ever attempted buy_pass.
 * So on that rail neither side can see the relationship.
 *
 * CHEAPEST PARTIAL FIX WHEN THE TRIGGER FIRES: pass the nonce on the REST rail
 * too. It costs one argument and converts "unrecoverable" into "recoverable
 * from chain", without storing anything about a buyer we were not already told.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ⚠️ THE CONSEQUENCE WITH MONEY ATTACHED: WE CANNOT REVOKE A DISPUTED PASS.
 *
 * A PassEntry carries NO PAYMENT HANDLE — no Stripe session id, no transaction
 * hash. The ledger's `settled` event DOES carry a stable `id` for exactly this
 * purpose. So both halves of the link exist and NOTHING JOINS THEM.
 *
 * The revocation surface confirms the shape rather than merely suggesting it:
 *   revokePass(token)          — needs the token, which only the holder has
 *   revokePendingPass(nonce)   — needs a nonce the REST rail never records
 *   revokeInternalPasses()     — skips everything non-internal by construction
 * For a pass minted on the REST rail or through Stripe guest checkout — the path
 * a stranger actually uses — WE HOLD NO IDENTIFIER THAT CAN REVOKE IT.
 *
 * Sized from our own constants, not estimated: PASS_CALL_CAP 10,000 calls over
 * PASS_DAYS 30 is $200.00 of service at our own per-call price, against a $9.00
 * chargeback. The free tier over the same window is 1,500 calls, so the pass is
 * worth keeping rather than notional. stripe.ts already contemplates "a
 * chargeback plus a dispute mark", so the rail is real.
 *
 * ⚠️ AND THE MITIGATION DEGRADES AS THE BUSINESS SUCCEEDS, which is the worst
 * available shape. This is UNLINKED, not unrecoverable: with sales this rare you
 * can correlate a settlement and a mint by timestamp and be right. That works
 * precisely while volume is near zero and fails SILENTLY the moment two sales
 * land close together — the exact condition we are trying to create. So it must
 * not wait for the first dispute to be noticed.
 *
 * The Stripe half is one field: store the session id on the entry at mint. It is
 * not personal data beyond what Stripe already holds, and it converts "we cannot
 * find the pass this charge paid for" into a lookup.
 */
export function mintPass(
  opts: { payer?: string; pending?: boolean; nonce?: string; days?: number; cap?: number; internal?: boolean } = {},
): { token: string; expires_at: string; call_cap: number } {
  const { payer, pending = false, nonce, days, cap, internal } = opts;
  const token = `btxp_${randomBytes(24).toString('hex')}`;
  const now = Date.now();
  const key = hashToken(token);
  const entry: PassEntry = {
    issued: now,
    expires: now + (days ?? PASS_DAYS) * 86_400_000,
    calls_used: 0,
    payer,
    active: !pending,
    ...(cap === undefined ? {} : { cap }),
    ...(internal ? { internal: true } : {}),
  };
  passes.set(key, entry);
  if (pending && nonce) {
    entry.nonce = nonce;
    reapPending(now);
    pendingByNonce.set(nonce, { key, at: now });
  }
  flush();
  console.log(
    `[pass] MINTED ${key.slice(0, 12)} ${pending ? 'PENDING (awaiting settlement)' : 'active'} ` +
      `payer=${payer ?? 'unknown'} expires=${new Date(entry.expires).toISOString()}`,
  );
  return { token, expires_at: new Date(entry.expires).toISOString(), call_cap: entry.cap ?? PASS_CALL_CAP };
}

/**
 * Confirm a pending pass after its payment settled. Returns false when there is
 * nothing to activate (unknown nonce, already reaped) — the caller should log
 * loudly rather than mint a replacement.
 */
export function activatePass(nonce: string, payer?: string, unconfirmedReason?: string): boolean {
  const pending = pendingByNonce.get(nonce);
  if (!pending) return false;
  pendingByNonce.delete(nonce);
  const entry = passes.get(pending.key);
  if (!entry) return false;
  entry.active = true;
  if (payer) entry.payer = payer;
  if (unconfirmedReason) entry.unconfirmed = unconfirmedReason;
  flush();
  console.log(
    `[pass] ACTIVATED ${pending.key.slice(0, 12)} payer=${payer ?? 'unknown'}` +
      (unconfirmedReason ? ` UNCONFIRMED (${unconfirmedReason})` : ''),
  );
  return true;
}

/** Drop a pending pass whose payment affirmatively did not settle. */
export function revokePendingPass(nonce: string, reason: string): boolean {
  const pending = pendingByNonce.get(nonce);
  if (!pending) return false;
  pendingByNonce.delete(nonce);
  const existed = passes.delete(pending.key);
  rateWindows.delete(pending.key);
  if (existed) flush();
  console.error(`[pass] DISCARDED pending ${pending.key.slice(0, 12)} - ${reason}`);
  return existed;
}

/**
 * Renew a pass for another period: push the expiry out and reset the call count.
 *
 * Exists because a subscription that charges a second month and delivers nothing
 * is money taken and service not delivered — the invariant this codebase goes to
 * real lengths to protect on the x402 rail, where settlement ambiguity
 * deliberately fails toward the customer. A recurring card charge reaches the
 * same failure by a duller route: the pass simply expires on day 31 while Stripe
 * keeps billing. The customer notices before we do, because nothing on our side
 * is watching.
 *
 * Resets calls_used rather than accumulating, because the cap is per period and
 * a renewed subscriber is buying another period's allowance, not a lifetime one.
 *
 * Returns false when there is nothing to renew — an unknown or already-reaped
 * token. The caller must log that loudly rather than mint a replacement: a
 * renewal for a pass we cannot find means our record and Stripe's disagree, and
 * quietly minting would paper over exactly the divergence worth seeing.
 */
export function renewPass(token: string, days = PASS_DAYS): boolean {
  const entry = passes.get(hashToken(token));
  if (!entry) return false;
  entry.expires = Date.now() + days * 86_400_000;
  entry.calls_used = 0;
  entry.active = true;
  flush();
  console.log(`[pass] RENEWED ${hashToken(token).slice(0, 12)} until ${new Date(entry.expires).toISOString()}`);
  return true;
}

/**
 * What a pass holder currently has, WITHOUT consuming a call.
 *
 * `usePass` spends a credit, so it cannot answer "what do I already own" — and
 * that question needs answering before we offer somebody a second pass. A
 * customer connecting with a valid pass sees `buy_pass` in their tool list
 * saying "Buy a 30-day pass for $9", with nothing indicating they hold one
 * already. A human might shrug; an autonomous agent low on context and looking
 * for more calls can simply buy again, and that is a real customer charged
 * twice for something they already have — the money-taken-nothing-delivered
 * shape, arriving through the front door instead of a bug.
 *
 * Read-only on purpose: an inspector that changes what it inspects is how the
 * revenue counters went wrong, and it is not a mistake to repeat on the object
 * a buyer paid for.
 */
export function passStatus(
  token: string,
  now = Date.now(),
): { valid: false } | { valid: true; remaining: number; expiresAt: string; daysLeft: number } {
  const entry = passes.get(hashToken(token));
  if (!entry || !entry.active || now > entry.expires) return { valid: false };
  return {
    valid: true,
    remaining: Math.max(0, PASS_CALL_CAP - entry.calls_used),
    expiresAt: new Date(entry.expires).toISOString(),
    daysLeft: Math.max(0, Math.ceil((entry.expires - now) / 86_400_000)),
  };
}

export type PassCheck =
  | { ok: true; remaining: number }
  | { ok: false; reason: 'invalid' | 'not_activated' | 'expired' | 'cap_exhausted' | 'rate_limited' };

/**
 * Validate a presented pass and, when valid, consume one call against it.
 */
export function usePass(token: string): PassCheck {
  const key = hashToken(token);
  const entry = passes.get(key);
  if (!entry) return { ok: false, reason: 'invalid' };
  // Minted but its payment never confirmed: the token exists, buys nothing.
  if (!entry.active) return { ok: false, reason: 'not_activated' };
  const now = Date.now();
  if (now > entry.expires) {
    passes.delete(key);
    flush();
    return { ok: false, reason: 'expired' };
  }
  const cap = entry.cap ?? PASS_CALL_CAP;
  if (entry.calls_used >= cap) return { ok: false, reason: 'cap_exhausted' };

  const rw = rateWindows.get(key);
  if (!rw || now - rw.windowStart > 60_000) {
    rateWindows.set(key, { count: 1, windowStart: now });
  } else if (++rw.count > PASS_RATE_PER_MINUTE) {
    return { ok: false, reason: 'rate_limited' };
  }

  entry.calls_used++;
  flush();
  return { ok: true, remaining: cap - entry.calls_used };
}

/**
 * Void a pass. Used when a mint was released but the payment affirmatively did
 * NOT settle — the pass was never paid for, so it must not stay valid. Only
 * call this on an affirmative "no funds moved"; an ambiguous or unknown
 * settlement result must leave the pass alone (never strand a paying customer).
 */
export function revokePass(token: string): boolean {
  const key = hashToken(token);
  if (!passes.delete(key)) return false;
  rateWindows.delete(key);
  flush();
  console.error(`[pass] REVOKED ${key.slice(0, 12)} - payment did not settle`);
  return true;
}

/**
 * Delete every self-issued internal pass. Returns how many went.
 *
 * THIS IS WHAT BOUNDS THE INTERNAL GRANT, and it exists because the obvious
 * bound does not work here. Security's review asked for idempotent minting —
 * return the existing pass instead of issuing another — which is the right
 * instinct and is impossible in this store: **only a hash of each token is
 * kept, deliberately, so that the file cannot be used to mint access.** The
 * token string is unrecoverable by construction, so an existing pass can never
 * be handed back.
 *
 * Revoke-then-mint reaches the same bound from the other side: at most ONE
 * internal pass exists at any moment, so repeated POSTs cannot accumulate
 * grants. Without this, every request would mint a fresh cap and the cap would
 * be decorative — an attacker holding the token would have unbounded service
 * rather than one pass's worth.
 */
export function revokeInternalPasses(): number {
  let gone = 0;
  for (const [k, e] of passes) {
    if (!e.internal) continue;
    passes.delete(k);
    rateWindows.delete(k);
    gone++;
  }
  if (gone > 0) {
    flush();
    console.log(`[pass] revoked ${gone} prior internal pass(es) — only one may exist at a time`);
  }
  return gone;
}

/** Give back a consumed pass call when the failure was on our side. */
export function refundPassUse(token: string): void {
  const entry = passes.get(hashToken(token));
  if (!entry || entry.calls_used <= 0) return;
  entry.calls_used--;
  flush();
}

/**
 * Passes that were activated without a confirmed settlement. These are the only
 * ones that could turn out to be unpaid, so they are the reconciliation
 * worklist: check each against the payout wallet / authorizationState on-chain.
 * Returns hashed keys, never tokens.
 */
export function listUnconfirmed(): Array<{ key: string; reason: string; payer?: string; issued: number; nonce?: string }> {
  const out: Array<{ key: string; reason: string; payer?: string; issued: number; nonce?: string }> = [];
  for (const [key, e] of passes) {
    // Both failure shapes belong here: activated-without-confirmation, and
    // stranded-by-restart. They are opposites — one gave service that may not
    // have been paid for, the other took payment that may have given no
    // service — but the operator's question is the same, "which passes need a
    // human to look at them", and splitting that across two places is how one
    // of them stops being checked.
    const reason = e.unconfirmed ?? e.stranded;
    if (reason) out.push({ key: key.slice(0, 12), reason, payer: e.payer, issued: e.issued, nonce: e.nonce });
  }
  return out;
}

/** Aggregate stats for /stats and the daily report. */
export function passSnapshot(): { active_passes: number; pass_calls_used: number } {
  const now = Date.now();
  let calls = 0;
  let active = 0;
  for (const e of passes.values()) {
    // Self-issued passes are not sales. Excluded STRUCTURALLY so `active_passes`
    // cannot read as a customer the way BUG-1's counter did — the disambiguating
    // context lives in the data, not in a reader's memory of what shipped today.
    if (e.internal) continue;
    if (e.expires > now && e.active) {
      active++;
      calls += e.calls_used;
    }
  }
  return { active_passes: active, pass_calls_used: calls };
}
