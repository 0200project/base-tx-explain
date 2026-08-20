import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DAY, HOUR, TtlCache } from './cache.js';

const FREE_CALLS = Math.max(0, Number.parseInt(process.env.FREE_CALLS_PER_IP ?? '10', 10) || 0);
const WINDOW_MS = 30 * DAY;

/**
 * Free-call counts, persisted to the same volume as the usage ledger.
 *
 * These used to live only in memory, which quietly made the paywall optional:
 * every deploy reset every client's count, so an agent using this across a few
 * days never reached the wall no matter how many calls it made. Restarts are
 * frequent, so that was not an edge case — it was the normal path, and it made
 * revenue structurally impossible.
 *
 * Counts are keyed by a salted hash of the client identifier, so the file holds
 * no addresses. The window is 30 days from a client's FIRST free call, not a
 * rolling TTL per call: without a fixed start a heavy caller's window would be
 * pushed forward on every request and never expire.
 */
interface FreeEntry {
  used: number;
  /** epoch ms of the first free call in the current window */
  windowStart: number;
}

const dataDir = process.env.DATA_DIR ?? './data';
const statePath = join(dataDir, 'free-tier.json');

const freeCalls = new Map<string, FreeEntry>();
let persistent = false;
let dirty = false;

/** Salted so the state file cannot be reversed into a client list. */
function keyOf(ip: string): string {
  return createHash('sha256').update(`btx-free:${ip}`).digest('hex').slice(0, 16);
}

function prune(now: number): void {
  for (const [k, e] of freeCalls) {
    if (now - e.windowStart > WINDOW_MS) freeCalls.delete(k);
  }
}

export function initFreeTier(): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    if (existsSync(statePath)) {
      const raw = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, FreeEntry>;
      for (const [k, e] of Object.entries(raw)) {
        if (e && typeof e.used === 'number' && typeof e.windowStart === 'number') freeCalls.set(k, e);
      }
    }
    prune(Date.now());
    persistent = true;
    console.log(`free tier: ${statePath} (${freeCalls.size} clients tracked, ${FREE_CALLS} free calls each)`);
  } catch (err) {
    // A broken state file must never take the service down. Degrading to
    // in-memory means over-granting free calls, never wrongly charging.
    console.error('free-tier state unavailable, counting in memory only:', err);
  }
}

/** Atomic write: a torn file here would hand everyone a fresh free tier. */
function flush(): void {
  if (!persistent || !dirty) return;
  try {
    const tmp = `${statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(freeCalls)));
    renameSync(tmp, statePath);
    dirty = false;
  } catch (err) {
    persistent = false;
    console.error('free-tier persistence failed, continuing in memory:', err);
  }
}

/** Consume one free call for this client if any remain. */
export function consumeFreeCall(ip: string): boolean {
  if (FREE_CALLS <= 0) return false;
  const now = Date.now();
  const key = keyOf(ip);
  const entry = freeCalls.get(key);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    freeCalls.set(key, { used: 1, windowStart: now });
    dirty = true;
    flush();
    return true;
  }
  if (entry.used >= FREE_CALLS) return false;
  entry.used++;
  dirty = true;
  flush();
  return true;
}

/** Return a consumed free call, e.g. when the decode failed on our side. */
export function refundFreeCall(ip: string): void {
  const entry = freeCalls.get(keyOf(ip));
  if (!entry || entry.used <= 0) return;
  entry.used--;
  dirty = true;
  flush();
}

/** How many free calls this client has left. Exposed for diagnostics. */
export function freeCallsRemaining(ip: string): number {
  const entry = freeCalls.get(keyOf(ip));
  if (!entry || Date.now() - entry.windowStart > WINDOW_MS) return FREE_CALLS;
  return Math.max(0, FREE_CALLS - entry.used);
}

const RATE_LIMIT_PER_MINUTE = 60;

// Deliberately NOT persisted: a one-minute throttle has no meaning across a
// restart, and rebuilding it would only ever punish a caller for traffic sent
// before the process existed.
const requestWindow = new TtlCache<{ count: number; windowStart: number }>(50_000, HOUR);

/** Coarse per-IP request throttle so a single client cannot exhaust upstream RPC quota. */
export function withinRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = requestWindow.get(ip);
  if (!entry || now - entry.windowStart > 60_000) {
    requestWindow.set(ip, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_PER_MINUTE;
}
