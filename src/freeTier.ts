import { DAY, HOUR, TtlCache } from './cache.js';

const FREE_CALLS = Math.max(0, Number.parseInt(process.env.FREE_CALLS_PER_IP ?? '10', 10) || 0);

// In-memory counters: resets on restart, which errs in the caller's favor.
const freeCalls = new TtlCache<number>(50_000, 30 * DAY);
const requestWindow = new TtlCache<{ count: number; windowStart: number }>(50_000, HOUR);

/** Consume one free call for this client if any remain. */
export function consumeFreeCall(ip: string): boolean {
  const used = freeCalls.get(ip) ?? 0;
  if (used >= FREE_CALLS) return false;
  freeCalls.set(ip, used + 1);
  return true;
}

const RATE_LIMIT_PER_MINUTE = 60;

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
