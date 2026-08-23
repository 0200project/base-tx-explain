import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

/**
 * How long a waiting entry survives a restart before it is history, not a gauge.
 *
 * A buyer stuck for six hours is still stuck and we want to know. A session id
 * from three days ago is a record, not somebody standing at the counter, and
 * leaving it in the live count would make `buyers_waiting` a number that only
 * ever climbs — the same defect as a counter that cannot fall.
 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface Waiter {
  firstSeen: number;
  alarmed: boolean;
}

const waiting = new Map<string, Waiter>();

/**
 * PERSISTED, because a restart must not reset a real buyer's clock.
 *
 * Surface found this: nine deploys in ninety minutes, and one restart landed
 * twenty-five seconds after a stuck entry appeared. In memory only, every
 * deploy wipes every waiting buyer — so a genuine buyer polling a page that
 * will not resolve has their 45-second clock reset by our shipping, and at any
 * real deploy cadence they may never trip the alarm at all. The instrument
 * built to notice a stranded customer would go blank precisely while we were
 * busy changing things, which is exactly when we are most likely to strand one.
 *
 * `webhookHealth` already persists for this reason and I wrote the comment
 * explaining why — "a restart forgets that a delivery was rejected, which
 * under-reports rather than falsely reassures" — and then built this module
 * with no persistence at all. Same lesson, same night, one file over.
 *
 * Failure to write degrades to memory-only and says so, rather than throwing on
 * a payment path.
 */
const dataDir = process.env.DATA_DIR ?? './data';
const statePath = join(dataDir, 'waiting-buyers.json');
let persistent = false;

export function initWaitingBuyers(now = Date.now()): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    if (existsSync(statePath)) {
      const raw = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, Waiter>;
      for (const [id, w] of Object.entries(raw)) {
        if (typeof w?.firstSeen !== 'number') continue;
        // Stale entries are dropped rather than resurrected: see MAX_AGE_MS.
        if (now - w.firstSeen >= MAX_AGE_MS) continue;
        if (waiting.size >= MAX_TRACKED) break;
        waiting.set(id, { firstSeen: w.firstSeen, alarmed: w.alarmed === true });
      }
    }
    persistent = true;
  } catch (err) {
    console.error('waiting-buyer state unavailable, counting in memory only:', err);
  }
}

function persist(): void {
  if (!persistent) return;
  try {
    const tmp = `${statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(waiting)));
    renameSync(tmp, statePath);
  } catch (err) {
    persistent = false;
    console.error('waiting-buyer write failed, continuing in memory:', err);
  }
}

/**
 * How often we have been unable to track an arriving buyer at all.
 *
 * Monotonic and never reset, because the log line that reports it is throttled
 * and a throttled log must not be the only record. Reaching this state is never
 * normal: either someone is holding every slot past the threshold, or that many
 * buyers are genuinely stuck. Both readings demand attention and neither is
 * survivable silently — going quiet exactly when the system saturates is the
 * blindness this module was built to remove, restored by saturation instead of
 * by absence.
 */
let refusedTracking = 0;

/**
 * Our own marked probes. Counted so the exclusion is visible rather than
 * silent — a filter nobody can see is indistinguishable from no traffic.
 */
let internalProbes = 0;

/**
 * Entries a human inspected and cleared. Kept as a running total rather than
 * deleted, so "we cleared three of these tonight" survives the clearing — the
 * same reason the webhook acknowledgement keeps its count.
 */
let acknowledgedTotal = 0;

/**
 * Test-mode sessions seen at /paid. Never customers, never incidents, but
 * counted — a test purchase mints a working pass on purpose, so if that flow
 * breaks the number should still be visible to whoever is running the test.
 */
let testModeProbes = 0;

/** Throttle for the saturation log only. The counter above is always exact. */
const REFUSAL_LOG_EVERY_MS = 60_000;
let lastRefusalLoggedAt = 0;

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

export type WaitingOutcome =
  /** Nothing new to say: a first sighting, still inside the window, or already escalated. */
  | { kind: 'quiet' }
  /** This buyer has waited past the point where "still processing" explains it. */
  | { kind: 'stuck'; waitedMs: number }
  /**
   * We could not track them at all — every slot holds a threshold-crossed
   * buyer. `shout` is the throttle: false means only the counter should move,
   * because the log has already said this within the last minute. `total` is
   * exact regardless, so a throttled log never becomes the only record.
   */
  | { kind: 'untracked'; tracked: number; total: number; shout: boolean };

/**
 * Record that this session still has no pass.
 *
 * Returns the wait worth shouting about, or null when there is nothing new to
 * say — a first sighting (normal for seconds after a payment), a wait still
 * inside the threshold, or one we have already escalated. Escalating once per
 * session rather than once per poll is deliberate: the page reloads on a timer,
 * and a log line per reload is how a real incident gets buried in its own noise.
 */
export function noteWaiting(
  sessionId: string,
  now = Date.now(),
  opts: { internal?: boolean } = {},
): WaitingOutcome {
  // OUR OWN PROBES ARE NOT BUYERS.
  //
  // Counted, never tracked. Within an hour of shipping this module I curled
  // /paid to verify the host cutover, forgot the marker was not wired here at
  // all, and put a phantom buyer on the gauge — then read `stuck: 1` and had to
  // work out whether a real customer was stranded. That is the sixth time my
  // own verification traffic has been mistaken for a stranger, and the first
  // where the instrument doing the mistaking was one I had written that day
  // while telling everyone else to use `scripts/ours.sh`.
  //
  // Same asymmetry as `internal.ts` and the webhook classifier: Stripe and a
  // real browser never send our marker, so forgetting it still errs toward
  // showing a buyer who is not there rather than hiding one who is. The safe
  // direction, and the reason this is a filter rather than a trust boundary.
  if (opts.internal) {
    internalProbes += 1;
    return { kind: 'quiet' };
  }

  // A TEST-MODE SESSION CANNOT BE A REAL CUSTOMER, so it is never a stranded one.
  //
  // Stripe issues `cs_live_` in live mode and `cs_test_` in test mode, and
  // `validSessionId` accepts both without distinction. Verified against our own
  // ledger rather than Stripe's documentation: the founder's real 07:50:24Z
  // purchase carries a `cs_live_` id, and the phantom stuck buyer that woke
  // everyone at 09:07Z was `cs_test_liveaudit...`.
  //
  // Security's fix and it is the right shape. The internal marker is opt-in, so
  // it has now failed to prevent this seven times — and every time the response
  // was to ask people to remember harder. This needs nobody to remember
  // anything: a test-mode id is structurally incapable of being a paying
  // customer, so it cannot be a customer we stranded. Same lesson as the
  // commit-msg hook and `scripts/ours.sh` — when discipline fails repeatedly,
  // the mechanism is the problem.
  //
  // Counted, not discarded: a test purchase DOES mint a working pass on purpose,
  // so if the flow breaks during a test we still want the number visible. It
  // just is not an incident, because a tester is present and watching.
  if (sessionId.startsWith('cs_test_')) {
    testModeProbes += 1;
    return { kind: 'quiet' };
  }
  let entry = waiting.get(sessionId);
  if (!entry) {
    if (waiting.size >= MAX_TRACKED && !evictOneDriveBy(now)) {
      // REFUSED, AND LOUD ABOUT IT. Every slot holds a buyer past the
      // threshold, so we decline the new id rather than displace a real one —
      // but declining silently would rebuild the exact blindness this module
      // removes. A genuine buyer arriving now is not being tracked, and there
      // is no reading of this state that is routine: either someone is holding
      // 512 ids past 45s, or 512 people are genuinely stuck. Security caught
      // that the first version returned here without a word.
      refusedTracking += 1;
      const shout = now - lastRefusalLoggedAt >= REFUSAL_LOG_EVERY_MS;
      if (shout) lastRefusalLoggedAt = now;
      return { kind: 'untracked', tracked: waiting.size, total: refusedTracking, shout };
    }
    entry = { firstSeen: now, alarmed: false };
    waiting.set(sessionId, entry);
    persist();
  }
  const waitedMs = now - entry.firstSeen;
  if (waitedMs < STUCK_AFTER_MS || entry.alarmed) return { kind: 'quiet' };
  entry.alarmed = true;
  persist();
  return { kind: 'stuck', waitedMs };
}

/** Their pass arrived. Drop them, so the gauge can fall as well as rise. */
export function resolveWaiting(sessionId: string): void {
  if (waiting.delete(sessionId)) persist();
}

/** Entries a human might need to look at before deciding to clear one. */
export function listWaiting(now = Date.now()): Array<{
  session_id: string;
  waited_seconds: number;
  alarmed: boolean;
}> {
  return [...waiting.entries()]
    .map(([id, w]) => ({
      session_id: id,
      waited_seconds: Math.round((now - w.firstSeen) / 1000),
      alarmed: w.alarmed,
    }))
    .sort((a, b) => b.waited_seconds - a.waited_seconds);
}

/**
 * A human has established this entry is not a stranded customer: clear it.
 *
 * WHY THIS HAS TO EXIST, and it is the same argument as the webhook incident
 * acknowledgement. Persistence — added an hour earlier so our own deploys stop
 * wiping stranded buyers — means a benign entry now survives for 24 hours and
 * holds every dashboard and every quality-check run red for a day. A control
 * that stays red on something everyone knows is fine is a control people learn
 * to ignore, and they learn it before the day it is right. That is the sticky
 * reconciler alarm and the permanent webhook incident, arriving a third time.
 *
 * It happened immediately: a teammate probed /paid without the internal marker
 * at 09:07:49Z, the server correctly recorded a stranger who asked for a pass
 * and did not get one, and there was no way to say "checked, it was us."
 *
 * DELIBERATELY NOT AUTOMATIC and deliberately per-session. Clearing everything
 * on a timer, or on the next successful delivery, would erase a real stranded
 * buyer at exactly the moment somebody is still owed something. It takes a
 * person, naming one session, and the count of what they cleared is kept rather
 * than deleted so the history survives the clearing.
 */
export function acknowledgeWaiting(sessionId: string): { cleared: boolean } {
  const had = waiting.delete(sessionId);
  if (had) {
    acknowledgedTotal += 1;
    persist();
  }
  return { cleared: had };
}

/**
 * Distinct buyers currently empty-handed, and how many are past the threshold.
 *
 * Computed at read time, not accumulated at write time: a buyer crosses the
 * threshold by the clock, not by polling us again. Otherwise the gauge would
 * only move when someone hits `/paid`, and the buyer who gave up and closed the
 * tab — the one most worth seeing — would never show as stuck.
 */
export function waitingSnapshot(now = Date.now()): {
  waiting: number;
  stuck: number;
  untracked: number;
  internal: number;
  acknowledged: number;
  test_mode: number;
} {
  let stuck = 0;
  for (const w of waiting.values()) {
    if (now - w.firstSeen >= STUCK_AFTER_MS) stuck += 1;
  }
  // `untracked` is published alongside the other two because the log that
  // reports saturation is throttled. A number on a surface someone reads is
  // the record; the log line is only the notification.
  return {
    waiting: waiting.size,
    stuck,
    untracked: refusedTracking,
    internal: internalProbes,
    acknowledged: acknowledgedTotal,
    test_mode: testModeProbes,
  };
}

/** Testing seam. */
export function __resetWaiting(): void {
  waiting.clear();
  persistent = false;
  refusedTracking = 0;
  lastRefusalLoggedAt = 0;
  internalProbes = 0;
  acknowledgedTotal = 0;
  testModeProbes = 0;
}
