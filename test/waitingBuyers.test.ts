import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_TRACKED,
  STUCK_AFTER_MS,
  __resetWaiting,
  noteWaiting,
  resolveWaiting,
  waitingSnapshot,
} from '../src/waitingBuyers.js';

/**
 * A buyer who paid and got nothing.
 *
 * Three properties carry this instrument, and each one exists because the
 * obvious implementation got it wrong first:
 *
 *  - it counts PEOPLE, not the reloads we told them to do;
 *  - a stranger with curl cannot raise the alarm, because `/paid` is public and
 *    the session id is only a shape check;
 *  - and a stranger with curl cannot SUPPRESS a real buyer either, which the
 *    first cap-and-evict version made cheap and which is the worse direction.
 */

const T0 = 1_700_000_000_000;

beforeEach(() => {
  __resetWaiting();
});

describe('counting buyers rather than requests', () => {
  it('counts one buyer once, however many times they reload', () => {
    // The success page re-fetches on every reload and we are the ones telling
    // them to reload. The first version incremented per request, so one stuck
    // buyer refreshing twelve times read as twelve people in trouble.
    for (let i = 0; i < 12; i++) noteWaiting('cs_alice', T0 + i * 1000);
    expect(waitingSnapshot(T0 + 12_000).waiting).toBe(1);
  });

  it('counts distinct buyers separately', () => {
    noteWaiting('cs_alice', T0);
    noteWaiting('cs_bob', T0);
    expect(waitingSnapshot(T0).waiting).toBe(2);
  });

  it('falls as well as rises once a pass arrives', () => {
    noteWaiting('cs_alice', T0);
    noteWaiting('cs_bob', T0);
    resolveWaiting('cs_alice');
    expect(waitingSnapshot(T0).waiting).toBe(1);
  });
});

describe('the alarm', () => {
  it('stays quiet on a first sighting, which is normal seconds after paying', () => {
    expect(noteWaiting('cs_alice', T0).kind).toBe('quiet');
  });

  it('stays quiet inside the threshold', () => {
    noteWaiting('cs_alice', T0);
    expect(noteWaiting('cs_alice', T0 + STUCK_AFTER_MS - 1).kind).toBe('quiet');
  });

  it('fires once the buyer has genuinely waited', () => {
    noteWaiting('cs_alice', T0);
    const hit = noteWaiting('cs_alice', T0 + STUCK_AFTER_MS);
    expect(hit.kind).toBe('stuck');
    expect(hit.kind === 'stuck' && hit.waitedMs).toBe(STUCK_AFTER_MS);
  });

  it('fires only ONCE per buyer, so a reload loop cannot bury the incident', () => {
    noteWaiting('cs_alice', T0);
    expect(noteWaiting('cs_alice', T0 + STUCK_AFTER_MS).kind).toBe('stuck');
    for (let i = 1; i <= 20; i++) {
      expect(noteWaiting('cs_alice', T0 + STUCK_AFTER_MS + i * 1000).kind).toBe('quiet');
    }
  });

  it('CANNOT be raised by a stranger with one curl', () => {
    // /paid is public and validSessionId is a shape check only — `cs_aaaaaaaa`
    // passes it. An alarm raisable from outside is one the operator learns to
    // ignore before the day it is real; that exact flaw was found in the webhook
    // classifier two days before this file existed.
    for (let i = 0; i < 500; i++) {
      expect(noteWaiting(`cs_drive_by_${i}`, T0).kind).toBe('quiet');
    }
    expect(waitingSnapshot(T0).stuck).toBe(0);
  });
});

describe('a flood must not hide a real buyer', () => {
  /**
   * The property that matters most, and the one the first implementation
   * inverted. Evicting the OLDEST entry targets the genuine stuck buyer almost
   * by definition — they arrived before the flood did. Their first-seen resets,
   * they never reach the threshold, they never alarm, and they vanish from the
   * count. The instrument built to make a lost buyer visible becomes the thing
   * hiding them, for the price of a few hundred curls.
   */
  it('keeps a real stuck buyer visible through a flood of fresh ids', () => {
    noteWaiting('cs_victim', T0);
    // They cross the threshold and alarm, like a real buyer polling the page.
    expect(noteWaiting('cs_victim', T0 + STUCK_AFTER_MS).kind).toBe('stuck');

    // Now a stranger floods far past the cap with distinct valid-shaped ids.
    for (let i = 0; i < MAX_TRACKED * 3; i++) {
      noteWaiting(`cs_flood_${i}`, T0 + STUCK_AFTER_MS + 1);
    }

    const snap = waitingSnapshot(T0 + STUCK_AFTER_MS + 1);
    expect(snap.stuck).toBe(1);
  });

  it('never lets the flood push the map past its bound', () => {
    for (let i = 0; i < MAX_TRACKED * 3; i++) noteWaiting(`cs_flood_${i}`, T0);
    expect(waitingSnapshot(T0).waiting).toBeLessThanOrEqual(MAX_TRACKED);
  });

  it('refuses new ids rather than displacing buyers when every slot is a real one', () => {
    // Fill every slot with buyers who have genuinely crossed the threshold.
    for (let i = 0; i < MAX_TRACKED; i++) noteWaiting(`cs_real_${i}`, T0);
    const later = T0 + STUCK_AFTER_MS;
    for (let i = 0; i < MAX_TRACKED; i++) noteWaiting(`cs_real_${i}`, later);
    expect(waitingSnapshot(later).stuck).toBe(MAX_TRACKED);

    // A flood arrives. Losing an untracked stranger costs nothing; losing a
    // real stuck buyer is the whole failure this module exists to prevent.
    for (let i = 0; i < 100; i++) noteWaiting(`cs_flood_${i}`, later + 1);

    const snap = waitingSnapshot(later + 1);
    expect(snap.stuck).toBe(MAX_TRACKED);
    expect(snap.waiting).toBe(MAX_TRACKED);
  });

  it('still evicts drive-bys in preference to anyone who has waited', () => {
    noteWaiting('cs_victim', T0);
    for (let i = 0; i < MAX_TRACKED * 2; i++) noteWaiting(`cs_flood_${i}`, T0 + 1);
    // The victim is still there and still ageing toward the threshold.
    const hit = noteWaiting('cs_victim', T0 + STUCK_AFTER_MS);
    expect(hit.kind).toBe('stuck');
    expect(hit.kind === 'stuck' && hit.waitedMs).toBe(STUCK_AFTER_MS);
  });
});

/**
 * Saturation must never be silent.
 *
 * The first version of the refusal branch simply returned. Security caught it:
 * declining silently rebuilds the exact blindness this module removes, only by
 * saturation instead of by absence. There is no routine reading of the state —
 * either someone is holding every slot past the threshold, or that many people
 * are genuinely stuck — so it has to be reportable in both.
 */
describe('refusing to track is loud', () => {
  function saturate(at: number): void {
    for (let i = 0; i < MAX_TRACKED; i++) noteWaiting(`cs_real_${i}`, T0);
    for (let i = 0; i < MAX_TRACKED; i++) noteWaiting(`cs_real_${i}`, at);
  }

  it('reports the refusal rather than returning quietly', () => {
    const later = T0 + STUCK_AFTER_MS;
    saturate(later);
    const out = noteWaiting('cs_newcomer', later + 1);
    expect(out.kind).toBe('untracked');
    expect(out.kind === 'untracked' && out.tracked).toBe(MAX_TRACKED);
  });

  it('counts every refusal exactly, even while the log is throttled', () => {
    const later = T0 + STUCK_AFTER_MS;
    saturate(later);
    for (let i = 0; i < 50; i++) noteWaiting(`cs_new_${i}`, later + 1);
    // The counter is the record; the log line is only the notification.
    expect(waitingSnapshot(later + 1).untracked).toBe(50);
  });

  it('shouts on the first refusal and then throttles, so it cannot bury itself', () => {
    const later = T0 + STUCK_AFTER_MS;
    saturate(later);
    const first = noteWaiting('cs_a', later + 1);
    expect(first.kind === 'untracked' && first.shout).toBe(true);
    const second = noteWaiting('cs_b', later + 2);
    expect(second.kind === 'untracked' && second.shout).toBe(false);
  });

  it('shouts again once the throttle window has passed', () => {
    const later = T0 + STUCK_AFTER_MS;
    saturate(later);
    noteWaiting('cs_a', later + 1);
    const muted = noteWaiting('cs_b', later + 30_000);
    expect(muted.kind === 'untracked' && muted.shout).toBe(false);
    const audible = noteWaiting('cs_c', later + 61_000);
    expect(audible.kind === 'untracked' && audible.shout).toBe(true);
  });

  it('stays at zero in normal operation', () => {
    noteWaiting('cs_alice', T0);
    noteWaiting('cs_bob', T0);
    expect(waitingSnapshot(T0).untracked).toBe(0);
  });
});

describe('the threshold is shared with the pricing page', () => {
  it('is the value scripts/predeploy.sh gates against', () => {
    // One invariant in two files: the page switches the buyer from "reload" to
    // "email us" at the same mark, so we start listening exactly when the buyer
    // is told to shout. If this constant changes, the gate stops the deploy
    // until site/pricing/index.html matches.
    expect(STUCK_AFTER_MS).toBe(45_000);
  });
});
