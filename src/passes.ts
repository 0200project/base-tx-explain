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
      for (const [k, e] of Object.entries(raw)) {
        if (e && typeof e.expires === 'number' && e.expires > now) passes.set(k, e);
      }
    }
    persistent = true;
    console.log(`passes: ${statePath} (${passes.size} active)`);
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

/** Mint a new pass after a verified $9 payment. Returns the bearer token. */
export function mintPass(payer?: string): { token: string; expires_at: string; call_cap: number } {
  const token = `btxp_${randomBytes(24).toString('hex')}`;
  const now = Date.now();
  const entry: PassEntry = { issued: now, expires: now + PASS_DAYS * 86_400_000, calls_used: 0, payer };
  passes.set(hashToken(token), entry);
  flush();
  console.log(`[pass] MINTED ${hashToken(token).slice(0, 12)} payer=${payer ?? 'unknown'} expires=${new Date(entry.expires).toISOString()}`);
  return { token, expires_at: new Date(entry.expires).toISOString(), call_cap: PASS_CALL_CAP };
}

export type PassCheck =
  | { ok: true; remaining: number }
  | { ok: false; reason: 'invalid' | 'expired' | 'cap_exhausted' | 'rate_limited' };

/**
 * Validate a presented pass and, when valid, consume one call against it.
 */
export function usePass(token: string): PassCheck {
  const key = hashToken(token);
  const entry = passes.get(key);
  if (!entry) return { ok: false, reason: 'invalid' };
  const now = Date.now();
  if (now > entry.expires) {
    passes.delete(key);
    flush();
    return { ok: false, reason: 'expired' };
  }
  if (entry.calls_used >= PASS_CALL_CAP) return { ok: false, reason: 'cap_exhausted' };

  const rw = rateWindows.get(key);
  if (!rw || now - rw.windowStart > 60_000) {
    rateWindows.set(key, { count: 1, windowStart: now });
  } else if (++rw.count > PASS_RATE_PER_MINUTE) {
    return { ok: false, reason: 'rate_limited' };
  }

  entry.calls_used++;
  flush();
  return { ok: true, remaining: PASS_CALL_CAP - entry.calls_used };
}

/** Give back a consumed pass call when the failure was on our side. */
export function refundPassUse(token: string): void {
  const entry = passes.get(hashToken(token));
  if (!entry || entry.calls_used <= 0) return;
  entry.calls_used--;
  flush();
}

/** Aggregate stats for /stats and the daily report. */
export function passSnapshot(): { active_passes: number; pass_calls_used: number } {
  const now = Date.now();
  let calls = 0;
  let active = 0;
  for (const e of passes.values()) {
    if (e.expires > now) {
      active++;
      calls += e.calls_used;
    }
  }
  return { active_passes: active, pass_calls_used: calls };
}
