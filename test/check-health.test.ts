import { afterEach, describe, expect, it } from 'vitest';
import {
  absorbCheckHealthEvent,
  checkHealthSnapshot,
  recordChecks,
  resetCheckHealth,
  takeCheckHealthEvents,
  type CheckHealthEvent,
} from '../src/checkHealth.js';
import type { CheckStatus, ChecksPerformed } from '../src/types.js';

afterEach(() => resetCheckHealth());

const NOW = new Date('2026-08-20T23:30:00.000Z');
const hoursBefore = (n: number, minutes = 0): Date =>
  new Date(NOW.getTime() - n * 3_600_000 + minutes * 60_000);

/** A `checks` block with everything `ok` unless overridden. */
function checks(over: Partial<Record<keyof ChecksPerformed, CheckStatus>> = {}): ChecksPerformed {
  return {
    contract_verification: 'ok',
    first_interaction: 'ok',
    drainer_blacklist: 'ok',
    unchecked_addresses: [],
    note: null,
    ...over,
  } as ChecksPerformed;
}

describe('checkHealthSnapshot — counting', () => {
  it('counts each status and excludes not_applicable from the attempt denominator', () => {
    for (let i = 0; i < 3; i++) recordChecks(checks(), hoursBefore(1));
    recordChecks(checks({ first_interaction: 'unavailable' }), hoursBefore(1));
    // A transaction with nothing for the check to look at is not a failed attempt.
    for (let i = 0; i < 96; i++) recordChecks(checks({ first_interaction: 'not_applicable' }), hoursBefore(1));

    const first = checkHealthSnapshot(24, NOW).checks.first_interaction;
    expect(first.ok).toBe(3);
    expect(first.unavailable).toBe(1);
    expect(first.not_applicable).toBe(96);
    expect(first.attempts).toBe(4);
    // 1 of 4, not 1 of 100: padding the day with inapplicable transactions must
    // not dilute an outage into invisibility.
    expect(first.unavailable_rate).toBe(0.25);
  });

  it('reports the window it covers and how much of it saw traffic', () => {
    recordChecks(checks(), hoursBefore(2));
    recordChecks(checks(), hoursBefore(1));
    const snap = checkHealthSnapshot(24, NOW);
    expect(snap.window_hours).toBe(24);
    expect(snap.observed_hours).toBe(2);
  });

  it('leaves a check with no traffic at a zero rate, which is not the same as healthy', () => {
    const snap = checkHealthSnapshot(24, NOW).checks.drainer_blacklist;
    expect(snap.attempts).toBe(0);
    expect(snap.unavailable_rate).toBe(0);
    expect(snap.last_unavailable_at).toBeNull();
  });

  it('ignores hours older than the requested window', () => {
    recordChecks(checks({ drainer_blacklist: 'unavailable' }), hoursBefore(30));
    recordChecks(checks(), hoursBefore(1));
    const day = checkHealthSnapshot(24, NOW).checks.drainer_blacklist;
    expect(day.unavailable).toBe(0);
    const week = checkHealthSnapshot(24 * 7, NOW).checks.drainer_blacklist;
    expect(week.unavailable).toBe(1);
  });
});

describe('checkHealthSnapshot — dark hours', () => {
  it('counts consecutive hours in which every attempt was unavailable', () => {
    // The measured incident's shape: one source down, nothing else affected.
    for (const h of [3, 2, 1]) {
      for (let i = 0; i < 4; i++) recordChecks(checks({ first_interaction: 'unavailable' }), hoursBefore(h));
    }
    const snap = checkHealthSnapshot(24, NOW).checks;
    expect(snap.first_interaction.dark_hours).toBe(3);
    // The most recent failing hour, not the first: NOW is 23:30, so the run is 20:00-22:00.
    expect(snap.first_interaction.last_unavailable_at).toBe('2026-08-20T22:00:00.000Z');
    // The other checks kept answering; an outage in one source must not smear
    // across the others.
    expect(snap.contract_verification.dark_hours).toBe(0);
    expect(snap.contract_verification.ok).toBe(12);
  });

  it('does not call an hour dark when even one attempt got an answer', () => {
    recordChecks(checks({ first_interaction: 'unavailable' }), hoursBefore(1));
    recordChecks(checks({ first_interaction: 'unavailable' }), hoursBefore(1));
    recordChecks(checks(), hoursBefore(1));
    const first = checkHealthSnapshot(24, NOW).checks.first_interaction;
    expect(first.dark_hours).toBe(0);
    expect(first.unavailable).toBe(2);
    expect(first.unavailable_rate).toBeCloseTo(0.6667, 3);
  });

  it('treats an hour with no traffic as no evidence, neither ending nor extending an outage', () => {
    for (let i = 0; i < 2; i++) recordChecks(checks({ first_interaction: 'unavailable' }), hoursBefore(4));
    // hour -3 and -2: nobody called. Counting silence as recovery would end an
    // outage on the strength of nobody having looked.
    for (let i = 0; i < 2; i++) recordChecks(checks({ first_interaction: 'unavailable' }), hoursBefore(1));
    expect(checkHealthSnapshot(24, NOW).checks.first_interaction.dark_hours).toBe(2);
  });

  it('does not treat inconclusive as an outage: nothing was down', () => {
    for (let i = 0; i < 5; i++) recordChecks(checks({ first_interaction: 'inconclusive' }), hoursBefore(1));
    const first = checkHealthSnapshot(24, NOW).checks.first_interaction;
    expect(first.inconclusive).toBe(5);
    expect(first.unavailable).toBe(0);
    expect(first.dark_hours).toBe(0);
    expect(first.last_unavailable_at).toBeNull();
    // Still counted as attempts: the check had work to do and produced no verdict.
    expect(first.attempts).toBe(5);
  });
});

describe('ledger rollups', () => {
  it('writes a closed hour once and does not rewrite it unchanged', () => {
    recordChecks(checks(), hoursBefore(1));
    const first = takeCheckHealthEvents(NOW);
    expect(first).toHaveLength(1);
    expect(first[0]?.hour).toBe('2026-08-20T22');
    expect(first[0]?.counts.contract_verification).toEqual({ ok: 1 });
    // Zero counters are omitted rather than written out as zeros.
    expect(first[0]?.counts.first_interaction).not.toHaveProperty('partial');
    expect(takeCheckHealthEvents(NOW)).toHaveLength(0);
  });

  it('persists an in-progress hour as soon as it degrades, without waiting for the hour to end', () => {
    recordChecks(checks(), NOW);
    // Healthy traffic in an open hour is cheap: nothing is written yet.
    expect(takeCheckHealthEvents(NOW)).toHaveLength(0);

    recordChecks(checks({ first_interaction: 'unavailable' }), NOW);
    const due = takeCheckHealthEvents(NOW);
    expect(due).toHaveLength(1);
    expect(due[0]?.hour).toBe('2026-08-20T23');
    expect(due[0]?.counts.first_interaction).toEqual({ ok: 1, unavailable: 1 });
    // Already written, nothing new has gone wrong.
    expect(takeCheckHealthEvents(NOW)).toHaveLength(0);

    // A second failure is new information and lands immediately too.
    recordChecks(checks({ first_interaction: 'unavailable' }), NOW);
    expect(takeCheckHealthEvents(NOW)).toHaveLength(1);
  });

  it('bounds how much of an open hour a crash can cost', () => {
    for (let i = 0; i < 49; i++) recordChecks(checks(), NOW);
    expect(takeCheckHealthEvents(NOW)).toHaveLength(0);
    recordChecks(checks(), NOW);
    expect(takeCheckHealthEvents(NOW)).toHaveLength(1);
  });

  it('replays last-write-wins, so a rewritten hour supersedes its earlier lines', () => {
    const early: CheckHealthEvent = {
      t: NOW.toISOString(),
      e: 'checks',
      hour: '2026-08-20T22',
      counts: { first_interaction: { ok: 1 } },
    };
    const final: CheckHealthEvent = {
      t: NOW.toISOString(),
      e: 'checks',
      hour: '2026-08-20T22',
      counts: { first_interaction: { ok: 1, unavailable: 4 } },
    };
    absorbCheckHealthEvent(early, NOW);
    absorbCheckHealthEvent(final, NOW);
    const first = checkHealthSnapshot(24, NOW).checks.first_interaction;
    expect(first.ok).toBe(1);
    expect(first.unavailable).toBe(4);
    // Replayed state is already on disk and must not be written back out.
    expect(takeCheckHealthEvents(NOW)).toHaveLength(0);
  });

  it('survives a round trip through the ledger with the numbers intact', () => {
    for (let i = 0; i < 3; i++) recordChecks(checks({ first_interaction: 'unavailable' }), hoursBefore(2));
    recordChecks(checks({ contract_verification: 'partial' }), hoursBefore(1));
    const written = takeCheckHealthEvents(NOW);
    const before = checkHealthSnapshot(24, NOW);

    resetCheckHealth();
    for (const ev of written) absorbCheckHealthEvent(ev, NOW);
    expect(checkHealthSnapshot(24, NOW)).toEqual(before);
  });

  it('drops replayed hours that fall outside the retention window', () => {
    absorbCheckHealthEvent(
      { t: NOW.toISOString(), e: 'checks', hour: '2026-07-01T10', counts: { first_interaction: { unavailable: 9 } } },
      NOW,
    );
    expect(checkHealthSnapshot(24 * 30, NOW).checks.first_interaction.unavailable).toBe(0);
  });

  it('ignores a malformed rollup rather than throwing during replay', () => {
    const bad = { t: NOW.toISOString(), e: 'checks', hour: 'not-an-hour', counts: {} } as CheckHealthEvent;
    expect(() => absorbCheckHealthEvent(bad, NOW)).not.toThrow();
    expect(() =>
      absorbCheckHealthEvent(
        { t: NOW.toISOString(), e: 'checks', hour: '2026-08-20T22', counts: { first_interaction: { ok: -3 } } },
        NOW,
      ),
    ).not.toThrow();
    expect(checkHealthSnapshot(24, NOW).checks.first_interaction.ok).toBe(0);
  });
});
