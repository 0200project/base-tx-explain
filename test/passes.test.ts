import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the pass store at a throwaway dir BEFORE the module reads DATA_DIR.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'btx-pass-test-'));

const { initPasses, mintPass, usePass, passSnapshot, activatePass, revokePendingPass, PASS_CALL_CAP } =
  await import('../src/passes.js');

describe('passes', () => {
  beforeAll(() => {
    initPasses();
  });

  it('mints a usable pass with a 30-day expiry', () => {
    const pass = mintPass({ payer: '0xpayer' });
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

/**
 * The MCP payment wrapper runs the handler BEFORE it settles and returns the
 * handler's result to the caller either way, so the token string reaches a
 * caller whose payment never landed. A pending pass must therefore be inert.
 */
describe('passes — a pass is worthless until its payment settles', () => {
  it('a PENDING pass cannot be used (the MCP free-pass bug)', () => {
    const { token } = mintPass({ pending: true, nonce: '0xn-inert' });
    expect(token).toMatch(/^btxp_/); // the client does receive a token...
    expect(usePass(token)).toEqual({ ok: false, reason: 'not_activated' }); // ...that buys nothing
  });

  it('activates on confirmed settlement and then works', () => {
    const { token } = mintPass({ pending: true, nonce: '0xn-ok' });
    expect(usePass(token).ok).toBe(false);
    expect(activatePass('0xn-ok', '0xpayer')).toBe(true);
    const used = usePass(token);
    expect(used.ok).toBe(true);
    if (used.ok) expect(used.remaining).toBe(PASS_CALL_CAP - 1);
  });

  it('a failed settlement discards the pending pass permanently', () => {
    const { token } = mintPass({ pending: true, nonce: '0xn-fail' });
    expect(revokePendingPass('0xn-fail', 'settlement not confirmed')).toBe(true);
    expect(usePass(token)).toEqual({ ok: false, reason: 'invalid' });
    // ...and a late or duplicate settlement cannot resurrect it.
    expect(activatePass('0xn-fail')).toBe(false);
    expect(usePass(token)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('one signed payment activates exactly one pass (concurrent replay)', () => {
    // N concurrent buys carrying the SAME authorization all pass verify, so all
    // N mint. Only one settle lands on-chain, so only one may become usable.
    const tokens = Array.from({ length: 5 }, () => mintPass({ pending: true, nonce: '0xn-replay' }).token);
    for (const t of tokens) expect(usePass(t).ok).toBe(false);

    expect(activatePass('0xn-replay')).toBe(true); // the one settlement that landed
    expect(activatePass('0xn-replay')).toBe(false); // nonce consumed; no second activation

    const usable = tokens.filter((t) => usePass(t).ok);
    expect(usable).toHaveLength(1);
  });

  it('the REST rail mints active (its middleware withholds the token on failure)', () => {
    const { token } = mintPass();
    expect(usePass(token).ok).toBe(true);
  });
});
