import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The set of engagement ids that have already been paid, so a settled
 * engagement's route can refuse a second charge.
 *
 * This exists because an engagement route stays live after it settles, and the
 * buyers are companies whose finance systems retry by design — an AP re-run or a
 * re-opened link would pay $1,500 a SECOND time, and x402 nonce protection does
 * not help (a fresh authorization is a valid payment). A manual on-chain refund
 * is a terrible first impression from a payments-competence vendor, so the fix
 * is to not take the money twice.
 *
 * Built against the three ways this codebase has failed at persisted money-path
 * state in one night:
 *
 *  1. DURABILITY. A memory-only set re-opens every settled engagement on the
 *     next deploy — the exact RETRIEVAL_WINDOW_MS shape that broke Stripe
 *     renewals. So it writes to /data and rebuilds at boot, and the boot rebuild
 *     (the part most likely to be skipped) is one call beside initPasses /
 *     initStripeDeliveries and is asserted by a settle-then-RESTART test, not an
 *     in-process one.
 *  2. WRITE ORDERING. The caller marks settled BEFORE it books revenue, in the
 *     same finish handler that books, so a crash in between fails toward
 *     "closed" (no second charge) rather than "payable". Under-booked revenue is
 *     recoverable from the payout wallet on-chain; a double charge is not
 *     recoverable without a refund.
 *  3. SAME ANSWER FOR SETTLED AS FOR UNKNOWN. The route answers a settled id
 *     identically to an unknown one (see rest.ts), so a prober cannot tell "this
 *     customer paid" from "no such engagement" — which would quietly reopen the
 *     confidentiality hole the no-title-on-the-wire change closes.
 */

const dataDir = process.env.DATA_DIR ?? './data';
const storePath = join(dataDir, 'settled-engagements.json');
const settled = new Set<string>();
let persistent = false;

/** Rebuild the settled set from disk. MUST run at boot, or a restart re-opens every settled engagement. */
export function initSettledEngagements(): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    if (existsSync(storePath)) {
      const raw = JSON.parse(readFileSync(storePath, 'utf8')) as unknown;
      if (Array.isArray(raw)) for (const id of raw) if (typeof id === 'string') settled.add(id);
    }
    persistent = true;
    console.log(`settled engagements: ${storePath} (${settled.size} closed)`);
  } catch (err) {
    // Memory-only degrades to "a restart re-opens settled engagements", which is
    // the exact double-charge this guards against — so say it loudly every boot
    // rather than let the gap survive in silence, the way the original did.
    console.error('settled-engagement store unavailable; a restart could re-open a settled engagement:', err);
  }
}

export function isEngagementSettled(id: string): boolean {
  return settled.has(id);
}

/**
 * Mark an engagement paid and persist it. Call BEFORE booking the revenue, so a
 * crash after this but before the ledger write leaves the engagement CLOSED
 * (safe) rather than payable (a second charge).
 */
export function markEngagementSettled(id: string): void {
  settled.add(id);
  if (!persistent) return;
  try {
    const tmp = `${storePath}.tmp`;
    writeFileSync(tmp, JSON.stringify([...settled]));
    renameSync(tmp, storePath);
  } catch (err) {
    persistent = false;
    console.error('settled-engagement write failed; continuing in memory (a restart may re-open this id):', err);
  }
}
