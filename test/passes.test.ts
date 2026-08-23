import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the pass store at a throwaway dir BEFORE the module reads DATA_DIR.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'btx-pass-test-'));

const { initPasses, mintPass, usePass, passSnapshot, activatePass, revokePendingPass, listUnconfirmed, passStatus, PASS_CALL_CAP } =
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

  it('activating on an ambiguous settle records WHY on the entry, not just in logs', () => {
    const { token } = mintPass({ pending: true, nonce: '0xn-ambig' });
    expect(activatePass('0xn-ambig', '0xpayer', 'settlement_pending tx=0xdeadbeef')).toBe(true);
    // The customer is not blocked...
    expect(usePass(token).ok).toBe(true);
    // ...and the unconfirmed activation is queryable from the store.
    const unconfirmed = listUnconfirmed();
    expect(unconfirmed.some((u) => u.reason.includes('settlement_pending'))).toBe(true);
  });
});

/**
 * What a holder already owns, without spending anything to ask.
 *
 * `usePass` consumes a credit, so it cannot answer "what do I have" — and that
 * question has to be answerable before we offer somebody a second pass. A
 * customer on a pass URL was being shown "Buy a 30-day pass for $9" with
 * nothing saying they held one; an agent low on calls could buy again while
 * sitting on thousands of unused credits. Charged twice for what they own.
 */
describe('passStatus', () => {
  it('reports what a holder has WITHOUT consuming a call', () => {
    const pass = mintPass({ payer: '0xholder' });
    const before = passStatus(pass.token);
    expect(before.valid).toBe(true);
    expect(before.valid && before.remaining).toBe(PASS_CALL_CAP);

    // Asking twice must not cost anything. An inspector that changes what it
    // inspects is how the revenue counters went wrong; not repeating it on the
    // object a buyer paid for.
    passStatus(pass.token);
    passStatus(pass.token);
    const after = passStatus(pass.token);
    expect(after.valid && after.remaining).toBe(PASS_CALL_CAP);

    // And a real use still decrements, so the reading is live rather than fixed.
    usePass(pass.token);
    const used = passStatus(pass.token);
    expect(used.valid && used.remaining).toBe(PASS_CALL_CAP - 1);
  });

  it('reports invalid for an unknown token rather than inventing a pass', () => {
    expect(passStatus('btxp_notarealtoken').valid).toBe(false);
  });

  it('reports invalid for a minted-but-unactivated pass', () => {
    // The token string exists but no payment confirmed, so it buys nothing —
    // and must not be described to its holder as an active pass.
    const pending = mintPass({ pending: true, nonce: 'nonce-status-test' });
    expect(passStatus(pending.token).valid).toBe(false);
  });

  it('reports invalid once expired', () => {
    const pass = mintPass({ payer: '0xexpiring' });
    const wayLater = Date.now() + 400 * 24 * 60 * 60 * 1000;
    expect(passStatus(pass.token, wayLater).valid).toBe(false);
  });

  it('carries days remaining, so a holder can see when to actually renew', () => {
    const pass = mintPass({ payer: '0xrenewer' });
    const st = passStatus(pass.token);
    expect(st.valid && st.daysLeft).toBeGreaterThan(0);
    expect(st.valid && typeof st.expiresAt).toBe('string');
  });
});
