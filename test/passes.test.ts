import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the pass store at a throwaway dir BEFORE the module reads DATA_DIR.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'btx-pass-test-'));

const { initPasses, mintPass, usePass, passSnapshot, PASS_CALL_CAP } = await import('../src/passes.js');

describe('passes', () => {
  beforeAll(() => {
    initPasses();
  });

  it('mints a usable pass with a 30-day expiry', () => {
    const pass = mintPass('0xpayer');
    expect(pass.token).toMatch(/^btxp_[0-9a-f]{48}$/);
    expect(pass.call_cap).toBe(PASS_CALL_CAP);
    const days = (new Date(pass.expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    const check = usePass(pass.token);
    expect(check).toEqual({ ok: true, remaining: PASS_CALL_CAP - 1 });
  });

  it('rejects unknown tokens', () => {
    expect(usePass('btxp_' + 'ab'.repeat(24))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('meters usage down to the cap', () => {
    const pass = mintPass();
    const first = usePass(pass.token);
    if (!first.ok) throw new Error('expected ok');
    const second = usePass(pass.token);
    if (!second.ok) throw new Error('expected ok');
    expect(second.remaining).toBe(first.remaining - 1);
  });

  it('rate-limits a single pass without consuming cap on rejection', () => {
    const pass = mintPass();
    let limited = 0;
    for (let i = 0; i < 70; i++) {
      const r = usePass(pass.token);
      if (!r.ok && r.reason === 'rate_limited') limited++;
    }
    expect(limited).toBe(10); // 60/min allowed, 70 attempted
  });

  it('reports aggregates without leaking tokens', () => {
    const snap = passSnapshot();
    expect(snap.active_passes).toBeGreaterThanOrEqual(3);
    expect(snap.pass_calls_used).toBeGreaterThan(0);
    expect(JSON.stringify(snap)).not.toContain('btxp_');
  });
});
