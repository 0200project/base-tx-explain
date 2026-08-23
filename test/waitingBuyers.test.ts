import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acknowledgeWaiting,
  listWaiting,
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

/**
 * Our own probes are not buyers.
 *
 * Added after I did it to myself: within an hour of shipping this module I
 * curled `/paid` to verify a host cutover, the marker was not wired into this
 * path at all, and a phantom buyer appeared on the gauge — then read `stuck: 1`
 * and had to work out whether a real customer was stranded. Sixth time my own
 * verification traffic has been mistaken for a stranger, first time the
 * instrument doing the mistaking was one I had written that day.
 */
describe('internal probes', () => {
  it('never appear as buyers', () => {
    noteWaiting('cs_ourprobe', T0, { internal: true });
    noteWaiting('cs_ourprobe', T0 + STUCK_AFTER_MS, { internal: true });
    const snap = waitingSnapshot(T0 + STUCK_AFTER_MS);
    expect(snap.waiting).toBe(0);
    expect(snap.stuck).toBe(0);
  });

  it('never raise the alarm, however long we poll', () => {
    for (let i = 0; i < 10; i++) {
      const out = noteWaiting('cs_ourprobe', T0 + i * 30_000, { internal: true });
      expect(out.kind).toBe('quiet');
    }
  });

  it('are counted, so the exclusion is visible rather than silent', () => {
    // A filter nobody can see is indistinguishable from no traffic.
    noteWaiting('cs_a', T0, { internal: true });
    noteWaiting('cs_b', T0, { internal: true });
    expect(waitingSnapshot(T0).internal).toBe(2);
  });

  it('does not hide a REAL buyer sharing the run', () => {
    // The filter must be per-request, not a global mute.
    noteWaiting('cs_ourprobe', T0, { internal: true });
    noteWaiting('cs_real', T0);
    expect(noteWaiting('cs_real', T0 + STUCK_AFTER_MS).kind).toBe('stuck');
    expect(waitingSnapshot(T0 + STUCK_AFTER_MS).stuck).toBe(1);
  });

  it('defaults to treating a caller as a buyer when the flag is absent', () => {
    // Forgetting the marker must err toward showing a buyer who is not there,
    // never toward hiding one who is. Stripe and a real browser never send it.
    noteWaiting('cs_unmarked', T0);
    expect(waitingSnapshot(T0).waiting).toBe(1);
  });
});

/**
 * A restart must not reset a real buyer's clock.
 *
 * Surface found this: nine deploys in ninety minutes, one landing twenty-five
 * seconds after a stuck entry appeared. In memory only, our own shipping resets
 * the 45-second clock of anyone genuinely stranded — so at any real deploy
 * cadence they may never trip the alarm. The instrument would go blank exactly
 * while we were changing things, which is when we are most likely to strand
 * someone.
 */
describe('surviving a restart', () => {
  function freshDir(): string {
    return mkdtempSync(join(tmpdir(), 'wb-'));
  }

  it('remembers a waiting buyer across a restart, clock intact', async () => {
    vi.resetModules();
    const dir = freshDir();
    process.env.DATA_DIR = dir;
    const a = await import('../src/waitingBuyers.js');
    a.__resetWaiting();
    a.initWaitingBuyers(T0);
    a.noteWaiting('cs_victim', T0);

    vi.resetModules();
    const b = await import('../src/waitingBuyers.js');
    b.initWaitingBuyers(T0 + 1000);
    // Their first-seen survived, so the very next poll past the threshold
    // escalates — rather than starting a fresh 45 seconds.
    const hit = b.noteWaiting('cs_victim', T0 + STUCK_AFTER_MS);
    expect(hit.kind).toBe('stuck');
    expect(hit.kind === 'stuck' && hit.waitedMs).toBe(STUCK_AFTER_MS);
  });

  it('forgets them once their pass arrives', async () => {
    vi.resetModules();
    const dir = freshDir();
    process.env.DATA_DIR = dir;
    const a = await import('../src/waitingBuyers.js');
    a.__resetWaiting();
    a.initWaitingBuyers(T0);
    a.noteWaiting('cs_ok', T0);
    a.resolveWaiting('cs_ok');

    vi.resetModules();
    const b = await import('../src/waitingBuyers.js');
    b.initWaitingBuyers(T0 + 1000);
    expect(b.waitingSnapshot(T0 + 1000).waiting).toBe(0);
  });

  it('drops entries too old to be someone standing at the counter', async () => {
    vi.resetModules();
    const dir = freshDir();
    process.env.DATA_DIR = dir;
    const a = await import('../src/waitingBuyers.js');
    a.__resetWaiting();
    a.initWaitingBuyers(T0);
    a.noteWaiting('cs_ancient', T0);

    vi.resetModules();
    const b = await import('../src/waitingBuyers.js');
    // Three days later: a record, not a live gauge. Keeping it would make
    // buyers_waiting a number that can only ever climb.
    b.initWaitingBuyers(T0 + 3 * 24 * 60 * 60 * 1000);
    expect(b.waitingSnapshot(T0 + 3 * 24 * 60 * 60 * 1000).waiting).toBe(0);
  });

  it('degrades to memory-only rather than throwing on an unwritable dir', async () => {
    vi.resetModules();
    process.env.DATA_DIR = '/proc/nonexistent-cannot-create';
    const m = await import('../src/waitingBuyers.js');
    expect(() => m.initWaitingBuyers(T0)).not.toThrow();
    // Still counts in memory — under-reporting across restarts beats a 500 on
    // a payment path.
    expect(() => m.noteWaiting('cs_x', T0)).not.toThrow();
    expect(m.waitingSnapshot(T0).waiting).toBe(1);
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

/**
 * A test-mode session is structurally incapable of being a real customer.
 *
 * Stripe issues cs_live_ in live mode and cs_test_ in test mode. Verified
 * against our own ledger rather than Stripe's docs: the founder's real
 * 07:50:24Z purchase carries a cs_live_ id, and the phantom stuck buyer that
 * woke the team at 09:07Z was cs_test_liveaudit...
 *
 * Security's fix, and the right shape. The internal marker is opt-in and had
 * failed to prevent this seven times; each time the response was to ask people
 * to remember harder. This needs nobody to remember anything.
 */
describe('test-mode sessions', () => {
  it('never count as waiting buyers, however long they poll', () => {
    noteWaiting('cs_test_liveaudit1787476069check', T0);
    const out = noteWaiting('cs_test_liveaudit1787476069check', T0 + STUCK_AFTER_MS * 10);
    expect(out.kind).toBe('quiet');
    const snap = waitingSnapshot(T0 + STUCK_AFTER_MS * 10);
    expect(snap.waiting).toBe(0);
    expect(snap.stuck).toBe(0);
  });

  it('are still counted, because a test purchase does mint a real pass', () => {
    noteWaiting('cs_test_aaa', T0);
    noteWaiting('cs_test_bbb', T0);
    expect(waitingSnapshot(T0).test_mode).toBe(2);
  });

  it('does NOT suppress a live session, which is the whole point', () => {
    noteWaiting('cs_live_realbuyer', T0);
    expect(noteWaiting('cs_live_realbuyer', T0 + STUCK_AFTER_MS).kind).toBe('stuck');
    expect(waitingSnapshot(T0 + STUCK_AFTER_MS).stuck).toBe(1);
  });
});

/**
 * An alarm with no off switch is one people learn to ignore.
 *
 * Persistence means a benign entry now survives 24h and holds every dashboard
 * red for a day. That is the sticky reconciler alarm and the permanent webhook
 * incident arriving a third time, so it gets the same answer webhookHealth
 * already has: a human names one entry and clears it, and the count is kept.
 */
describe('acknowledging a waiting entry', () => {
  it('clears exactly the named entry and nothing else', () => {
    noteWaiting('cs_live_a', T0);
    noteWaiting('cs_live_b', T0);
    expect(acknowledgeWaiting('cs_live_a').cleared).toBe(true);
    const snap = waitingSnapshot(T0);
    expect(snap.waiting).toBe(1);
    expect(snap.acknowledged).toBe(1);
    expect(listWaiting(T0).map((w) => w.session_id)).toEqual(['cs_live_b']);
  });

  it('reports honestly when the named entry was not there', () => {
    expect(acknowledgeWaiting('cs_live_neverseen').cleared).toBe(false);
    expect(waitingSnapshot(T0).acknowledged).toBe(0);
  });

  it('lists what is waiting so an operator can see WHICH buyer, not just a count', () => {
    noteWaiting('cs_live_old', T0);
    noteWaiting('cs_live_new', T0 + 10_000);
    const rows = listWaiting(T0 + 20_000);
    // Longest wait first: the one most likely to be a real problem.
    expect(rows[0].session_id).toBe('cs_live_old');
    expect(rows[0].waited_seconds).toBe(20);
  });
});
