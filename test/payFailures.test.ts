import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A payment that failed must leave a record saying WHY.
 *
 * This exists because of a specific, expensive silence. Nine external clients
 * attached a payment to a call and not one settled. The facilitator handed the
 * server a structured rejection every single time — we printed 8,000 characters
 * of it — and wrote it to a console log that has since rotated away.
 *
 * So "why did nobody convert" had no answer, and the two available conclusions
 * were both wrong in expensive directions: that nobody wanted the product, or
 * that the rail was broken. The evidence to tell them apart existed nine times
 * and was discarded nine times.
 */

async function load() {
  vi.resetModules();
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'btx-payfail-'));
  const m = await import('../src/usage.js');
  m.initUsageLedger();
  return m;
}

describe('payment failures are recorded, not just logged', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('keeps the REASON, which is the entire point', async () => {
    const m = await load();
    m.recordEvent({
      t: new Date().toISOString(),
      e: 'payfail',
      stage: 'settle',
      reason: 'insufficient_funds: payer balance 0',
      payer: '0xdeadbeef',
    });
    const f = m.payFailures();
    expect(f).toHaveLength(1);
    expect(f[0].reason).toContain('insufficient_funds');
    expect(f[0].stage).toBe('settle');
    expect(f[0].payer).toBe('0xdeadbeef');
  });

  it('counts them WITHOUT counting them as demand or revenue', async () => {
    // The two wrong readings available. A failed payment is neither a sale nor
    // an absence of interest, and conflating it with either loses the signal.
    const m = await load();
    m.recordEvent({ t: new Date().toISOString(), e: 'payfail', stage: 'verify', reason: 'bad signature' });
    const snap = m.usageSnapshot(1) as { lifetime: Record<string, number> };
    expect(snap.lifetime.payment_failures).toBe(1);
    expect(snap.lifetime.revenue_usd).toBe(0);
    expect(snap.lifetime.settlements).toBe(0);
    expect(snap.lifetime.calls).toBe(0);
  });

  it('records all three failure shapes, including the quiet one', async () => {
    // `unconfirmed` is the shape neither hook catches: the facilitator answers
    // HTTP 200 with success:false, nothing throws, and until this change it
    // recorded nothing at all. A payment that fails without throwing is the one
    // most likely to be mistaken for silence.
    const m = await load();
    for (const stage of ['verify', 'settle', 'unconfirmed'] as const) {
      m.recordEvent({ t: new Date().toISOString(), e: 'payfail', stage, reason: `${stage} detail` });
    }
    expect(m.payFailures().map((f) => f.stage)).toEqual(['verify', 'settle', 'unconfirmed']);
  });

  it('survives a restart, because a diagnosis that dies with the process is the bug', async () => {
    const m = await load();
    const dir = process.env.DATA_DIR;
    m.recordEvent({ t: new Date().toISOString(), e: 'payfail', stage: 'settle', reason: 'nonce already used' });

    vi.resetModules();
    process.env.DATA_DIR = dir;
    const fresh = await import('../src/usage.js');
    fresh.initUsageLedger();
    expect(fresh.payFailures()[0]?.reason).toContain('nonce already used');
    const snap = fresh.usageSnapshot(1) as { lifetime: Record<string, number> };
    expect(snap.lifetime.payment_failures).toBe(1);
  });

  it('is bounded, so a bad facilitator hour cannot grow /stats without limit', async () => {
    const m = await load();
    for (let i = 0; i < 60; i++) {
      m.recordEvent({ t: new Date().toISOString(), e: 'payfail', stage: 'settle', reason: `failure ${i}` });
    }
    const f = m.payFailures();
    expect(f.length).toBeLessThanOrEqual(20);
    // Newest kept: the oldest are the ones you can afford to lose.
    expect(f[f.length - 1].reason).toContain('failure 59');
  });
});
