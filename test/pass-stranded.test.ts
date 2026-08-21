import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';

/**
 * A $9 pass whose payment settles during a restart.
 *
 * The window is mint (in the handler, after verify) to `activatePass` (in the
 * settlement hook). Seconds — but we deploy many times an evening and a rolling
 * deploy stops the machine. If the process dies after the facilitator has
 * broadcast but before the hook runs, THE TRANSFER STILL COMPLETES ON CHAIN.
 *
 * $9 lands in the payout wallet with no pass issued and nothing in the ledger,
 * while the customer holds a token. Dropping the pending entry at boot left
 * NEITHER END ABLE TO FIND THE OTHER: the reconciler sees a receipt it cannot
 * attribute, support has nothing to search, and the buyer gets "invalid".
 *
 * The old reasoning was sound — a restored pending pass genuinely cannot be
 * activated, because the hook died with the process — but "cannot be activated"
 * justified marking it, not deleting it. Found by Security.
 */

async function boot(dir: string) {
  vi.resetModules();
  process.env.DATA_DIR = dir;
  const m = await import('../src/passes.js');
  m.initPasses();
  return m;
}

describe('a pending pass stranded by a restart', () => {
  let dir: string;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    dir = `/tmp/pass-${Math.random().toString(36).slice(2)}`;
    mkdirSync(dir, { recursive: true });
  });

  it('survives the restart as a discoverable record instead of vanishing', async () => {
    const first = await boot(dir);
    const minted = first.mintPass({ payer: '0xpayer', pending: true, nonce: '0xnonce1' });
    expect(first.usePass(minted.token).reason).toBe('not_activated');

    const second = await boot(dir);

    // It is still findable. Before the fix this returned 'invalid' — the pass
    // was gone, and a customer asking "I paid, what happened" could not be
    // answered from the store at all.
    const check = second.usePass(minted.token);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('not_activated');

    const unconfirmed = second.listUnconfirmed();
    expect(unconfirmed).toHaveLength(1);
    expect(unconfirmed[0]?.reason).toMatch(/restart/i);
    // The nonce is persisted, so the stranded pass can be matched against an
    // on-chain authorization rather than guessed at.
    expect(unconfirmed[0]?.nonce).toBe('0xnonce1');
  });

  it('does NOT count as an active pass, so it cannot inflate the scoreboard', async () => {
    // Retaining it must not make it look sold. Discoverable and unusable.
    const first = await boot(dir);
    first.mintPass({ payer: '0xpayer', pending: true, nonce: '0xnonce2' });
    const second = await boot(dir);
    expect(second.passSnapshot().active_passes).toBe(0);
  });

  it('shouts at boot, because a silent loss is the whole defect', async () => {
    const first = await boot(dir);
    first.mintPass({ payer: '0xpayer', pending: true, nonce: '0xnonce3' });

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await boot(dir);
    const said = err.mock.calls.flat().join(' ');
    expect(said).toMatch(/STRANDED/);
    expect(said).toMatch(/payout wallet/i);
  });

  it('control: an ACTIVATED pass still survives a restart intact', async () => {
    // The store itself is sound; only the pending path was losing records.
    // Without this control the fix could have broken the working case.
    const first = await boot(dir);
    const minted = first.mintPass({ payer: '0xpayer', pending: true, nonce: '0xnonce4' });
    expect(first.activatePass('0xnonce4', '0xpayer')).toBe(true);
    expect(first.usePass(minted.token).ok).toBe(true);

    const second = await boot(dir);
    expect(second.usePass(minted.token).ok).toBe(true);
    expect(second.passSnapshot().active_passes).toBe(1);
    // An activated pass is not stranded and must not appear as needing review.
    expect(second.listUnconfirmed()).toHaveLength(0);
  });

  it('an activated pass keeps its call count across the restart', async () => {
    const first = await boot(dir);
    const minted = first.mintPass({ payer: '0xpayer', pending: true, nonce: '0xnonce5' });
    first.activatePass('0xnonce5', '0xpayer');
    first.usePass(minted.token);
    first.usePass(minted.token);

    const second = await boot(dir);
    expect(second.passSnapshot().pass_calls_used).toBe(2);
  });
});

describe('the boot line a 3am debugger reads first', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('counts active and stranded separately, instead of calling both active', async () => {
    // `passes.size` meant "active" only while initPasses restored active
    // entries alone. Retaining stranded ones falsified the word — on the exact
    // line someone debugging a lost $9 reads first. Same family as a stale
    // comment: a true statement outliving the change that falsified it.
    const dir = `/tmp/pass-boot-${Math.random().toString(36).slice(2)}`;
    mkdirSync(dir, { recursive: true });

    const first = await boot(dir);
    first.mintPass({ payer: '0xpayer', pending: true, nonce: '0xbootnonce' });

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await boot(dir);
    const said = log.mock.calls.flat().join(' ');

    expect(said).toMatch(/0 active/);
    expect(said).toMatch(/1 STRANDED/);
  });

  it('says nothing about stranded when there are none', async () => {
    // The alarm must rest at silence, or it stops being read.
    const dir = `/tmp/pass-boot2-${Math.random().toString(36).slice(2)}`;
    mkdirSync(dir, { recursive: true });
    const first = await boot(dir);
    const m = first.mintPass({ payer: '0xp', pending: true, nonce: '0xn' });
    first.activatePass('0xn', '0xp');
    expect(m.token).toBeTruthy();

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await boot(dir);
    const said = log.mock.calls.flat().join(' ');
    expect(said).toMatch(/1 active/);
    expect(said).not.toMatch(/STRANDED/);
  });
});
