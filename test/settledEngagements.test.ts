import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * THE TEST THAT MATTERS (Security): in-process assertions prove the guard works
 * in a world without deploys, which is not our world — that is the exact gap
 * that hid the Stripe renewal defect (green suite, broken feature). So every
 * assertion here crosses a simulated RESTART: mark settled, throw the module
 * away, re-import, re-init from /data, then assert.
 */
describe('settled engagements survive a restart', () => {
  it('a settled id is STILL settled after the process restarts (rebuilt from disk)', async () => {
    vi.resetModules();
    const dir = mkdtempSync(join(tmpdir(), 'settled-eng-'));
    process.env.DATA_DIR = dir;
    const m1 = await import('../src/settledEngagements.js');
    m1.initSettledEngagements();
    m1.markEngagementSettled('pa-7f3c91');

    vi.resetModules();
    process.env.DATA_DIR = dir;
    const m2 = await import('../src/settledEngagements.js');
    m2.initSettledEngagements();
    expect(m2.isEngagementSettled('pa-7f3c91')).toBe(true); // survived the restart -> no second charge
    expect(m2.isEngagementSettled('never-paid')).toBe(false); // and nothing else leaked in
  });

  it('WITHOUT the boot rebuild, a restart RE-OPENS the engagement — proving the rebuild is load-bearing', async () => {
    // The failure this guards: memory-only state, or a skipped
    // initSettledEngagements. A fresh module that never re-inits does not know
    // the id was settled, which is exactly the double-charge. This asserts the
    // rebuild is what saves us, not a happy accident of lingering module state.
    vi.resetModules();
    const dir = mkdtempSync(join(tmpdir(), 'settled-eng-norebuild-'));
    process.env.DATA_DIR = dir;
    const m1 = await import('../src/settledEngagements.js');
    m1.initSettledEngagements();
    m1.markEngagementSettled('pa-abc123');

    vi.resetModules();
    process.env.DATA_DIR = dir;
    const m2 = await import('../src/settledEngagements.js');
    // deliberately NO initSettledEngagements() here — simulate the skipped boot rebuild
    expect(m2.isEngagementSettled('pa-abc123')).toBe(false); // re-opened: would take the money twice
  });

  it('accumulates across many restarts rather than overwriting', async () => {
    vi.resetModules();
    const dir = mkdtempSync(join(tmpdir(), 'settled-eng-accum-'));
    process.env.DATA_DIR = dir;
    let m = await import('../src/settledEngagements.js');
    m.initSettledEngagements();
    m.markEngagementSettled('one');

    vi.resetModules();
    process.env.DATA_DIR = dir;
    m = await import('../src/settledEngagements.js');
    m.initSettledEngagements();
    m.markEngagementSettled('two'); // second sale, a restart later

    vi.resetModules();
    process.env.DATA_DIR = dir;
    m = await import('../src/settledEngagements.js');
    m.initSettledEngagements();
    expect(m.isEngagementSettled('one')).toBe(true);
    expect(m.isEngagementSettled('two')).toBe(true);
  });
});
