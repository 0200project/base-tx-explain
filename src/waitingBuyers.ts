/**
 * Who has paid and is standing at the counter with nothing in their hands.
 *
 * WHY THIS EXISTS. `not_ready` lived in exactly one place — the `/paid` 404 —
 * and nothing counted it. A buyer reloading a page that would never resolve
 * produced no signal at all: we would not have learned it happened, let alone
 * that it kept happening. That is the one failure this service must never
 * produce silently, and it was the only one with no instrument on it. Security
 * found that; this module is the instrument.
 *
 * WHY IT COUNTS SESSIONS AND NOT REQUESTS. The first version incremented a
 * counter on every 404. The success page re-fetches on every reload and we are
 * explicitly telling the buyer to reload, so one stuck buyer refreshing twelve
 * times read as twelve buyers. The name said people; the number said requests.
 * Same defect class as the revenue figures we spent two days correcting, aimed
 * this time at whoever reads the dashboard at 3am deciding if there is a crisis.
 *
 * WHY THE ALARM WAITS. `/paid` is public and unauthenticated, and the session id
 * is a shape check only — `cs_aaaaaaaa` passes it. A stranger with curl could
 * otherwise fire the loudest log line we own, for free, with no payment and no
 * session. That is precisely the flaw Security found in the webhook classifier:
 * an alarm raisable from outside is one the operator learns to ignore before the
 * day it is real. Forgery cannot be prevented on a public endpoint, but it can
 * be made to cost something — a drive-by is merely counted, while a genuine
 * buyer polling the same id past the threshold is escalated, once.
 *
 * THE EVICTION POLICY IS THE LOAD-BEARING PART, NOT THE BOUND. The keys are
 * attacker-supplied so the map must be capped, and the obvious cap — evict the
 * oldest — is actively backwards: the oldest entry is the genuine stuck buyer
 * almost by definition, because they arrived before the flood did. Evicting
 * them resets their first-seen, so they never reach the threshold, never alarm,
 * and vanish from the count. The instrument built to make a lost buyer visible
 * would have been the thing hiding them. Suppression is worse than inflation,
 * and cheap suppression is worse still.
 *
 * So eviction only ever takes entries that have NOT crossed the threshold,
 * newest first — that is the flood, not the victim. When every slot holds a
 * genuinely stuck buyer we refuse to track new ids rather than displace a real
 * one: losing an untracked stranger costs nothing, losing a real stuck buyer is
 * the whole failure. A flood then costs the attacker sustained polling per id.
 *
 * NOT FOR PUBLICATION. These numbers belong behind the stats token. `stuck` on
 * an open endpoint is live feedback to a flooder that their flood is landing,
 * and announces that our payment path is failing at the moment it is failing.
 */

/**
 * When a wait stops being explainable as "the webhook is still in flight".
 *
 * SHARED WITH `site/pricing/index.html`, which switches the buyer from "reload"
 * to "email us" at the same mark — so we start listening exactly when the buyer
 * is told to shout. One invariant in two files, the same shape as
 * `kill_timeout`/`SHUTDOWN_GRACE_MS`, and `scripts/predeploy.sh` gates on them
 * agreeing. Changing it here alone stops the deploy.
 */
export const STUCK_AFTER_MS = 45_000;

/** Bounded because the keys arrive from strangers. */
export const MAX_TRACKED = 512;

interface Waiter {
  firstSeen: number;
  alarmed: boolean;
}

const waiting = new Map<string, Waiter>();

/**
 * Free a slot by dropping someone who has not waited long enough to matter,
 * newest first. Returns false when every entry has crossed the threshold —
 * the caller's signal to refuse the new id rather than evict a real buyer.
 */
function evictOneDriveBy(now: number): boolean {
  let candidate: string | null = null;
  let newest = -Infinity;
  for (const [id, w] of waiting) {
    if (w.alarmed || now - w.firstSeen >= STUCK_AFTER_MS) continue;
    if (w.firstSeen > newest) {
      newest = w.firstSeen;
      candidate = id;
    }
  }
  if (candidate === null) return false;
  waiting.delete(candidate);
  return true;
}

/**
 * Record that this session still has no pass.
 *
 * Returns the wait worth shouting about, or null when there is nothing new to
 * say — a first sighting (normal for seconds after a payment), a wait still
 * inside the threshold, or one we have already escalated. Escalating once per
 * session rather than once per poll is deliberate: the page reloads on a timer,
 * and a log line per reload is how a real incident gets buried in its own noise.
 */
export function noteWaiting(sessionId: string, now = Date.now()): { waitedMs: number } | null {
  let entry = waiting.get(sessionId);
  if (!entry) {
    if (waiting.size >= MAX_TRACKED && !evictOneDriveBy(now)) return null;
    entry = { firstSeen: now, alarmed: false };
    waiting.set(sessionId, entry);
  }
  const waitedMs = now - entry.firstSeen;
  if (waitedMs < STUCK_AFTER_MS || entry.alarmed) return null;
  entry.alarmed = true;
  return { waitedMs };
}

/** Their pass arrived. Drop them, so the gauge can fall as well as rise. */
export function resolveWaiting(sessionId: string): void {
  waiting.delete(sessionId);
}

/**
 * Distinct buyers currently empty-handed, and how many are past the threshold.
 *
 * Computed at read time, not accumulated at write time: a buyer crosses the
 * threshold by the clock, not by polling us again. Otherwise the gauge would
 * only move when someone hits `/paid`, and the buyer who gave up and closed the
 * tab — the one most worth seeing — would never show as stuck.
 */
export function waitingSnapshot(now = Date.now()): { waiting: number; stuck: number } {
  let stuck = 0;
  for (const w of waiting.values()) {
    if (now - w.firstSeen >= STUCK_AFTER_MS) stuck += 1;
  }
  return { waiting: waiting.size, stuck };
}

/** Testing seam. */
export function __resetWaiting(): void {
  waiting.clear();
}
