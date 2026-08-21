import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'btx-degraded-test-'));

/**
 * A call served free because payments were down is not free-tier demand and is
 * not a paywall hit. It arrives with charge=true and no payment payload, so
 * without its own bucket it lands in `wall_hits` — and an outage then reads as
 * people hitting the paywall, which is the flattering direction and the one we
 * can least afford while the open question is whether anyone wants this.
 */
async function freshLedger() {
  vi.resetModules();
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'btx-degraded-test-'));
  const m = await import('../src/usage.js');
  m.initUsageLedger();
  return m;
}

const call = (over: Record<string, unknown> = {}) => ({
  t: new Date().toISOString(),
  e: 'call' as const,
  charge: false,
  client: 'c1',
  ...over,
});

beforeEach(() => vi.resetModules());

describe('usage — an outage giveaway is not demand', () => {
  it('counts a degraded call apart from free AND from wall_hits', async () => {
    const { recordEvent, usageSnapshot } = await freshLedger();
    // Payments down, caller past their free tier: charged=true, served anyway.
    recordEvent(call({ charge: true, degraded: true }));
    const life = (usageSnapshot(1) as { lifetime: Record<string, number> }).lifetime;

    expect(life.degraded_calls).toBe(1);
    expect(life.wall_hits).toBe(0); // nobody hit a wall — they were served
    expect(life.free).toBe(0); // and it was not free-tier demand
    expect(life.calls).toBe(1); // still a real call
  });

  it('still counts an ordinary paywall hit as a paywall hit', async () => {
    const { recordEvent, usageSnapshot } = await freshLedger();
    recordEvent(call({ charge: true })); // payments up, caller turned away
    const life = (usageSnapshot(1) as { lifetime: Record<string, number> }).lifetime;
    expect(life.wall_hits).toBe(1);
    expect(life.degraded_calls).toBe(0);
  });

  it('still counts ordinary free-tier use as free', async () => {
    const { recordEvent, usageSnapshot } = await freshLedger();
    recordEvent(call({ charge: false }));
    const life = (usageSnapshot(1) as { lifetime: Record<string, number> }).lifetime;
    expect(life.free).toBe(1);
    expect(life.degraded_calls).toBe(0);
    expect(life.wall_hits).toBe(0);
  });

  it('keeps the buckets separable in a mixed day, so an outage cannot inflate demand', async () => {
    const { recordEvent, usageSnapshot } = await freshLedger();
    recordEvent(call({ charge: false, client: 'a' })); // organic free
    recordEvent(call({ charge: true, client: 'b' })); // real paywall hit
    recordEvent(call({ charge: true, degraded: true, client: 'c' })); // outage giveaway
    recordEvent(call({ charge: true, degraded: true, client: 'd' }));
    const snap = usageSnapshot(1) as { lifetime: Record<string, number>; daily: Array<Record<string, number>> };

    expect(snap.lifetime.free).toBe(1);
    expect(snap.lifetime.wall_hits).toBe(1); // NOT 3
    expect(snap.lifetime.degraded_calls).toBe(2);
    expect(snap.lifetime.calls).toBe(4);
    // and the daily series carries it too, since that is what gets charted
    expect(snap.daily[snap.daily.length - 1]?.degraded_calls).toBe(2);
  });

  it('a pass call during an outage is a pass call, not a giveaway', async () => {
    // Pass holders never touch the facilitator, so an outage does not change
    // their accounting: they spent a credit and got the decode they paid for.
    const { recordEvent, usageSnapshot } = await freshLedger();
    recordEvent(call({ charge: false, pass: true }));
    const life = (usageSnapshot(1) as { lifetime: Record<string, number> }).lifetime;
    expect(life.pass_calls).toBe(1);
    expect(life.degraded_calls).toBe(0);
  });
});
