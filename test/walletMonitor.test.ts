import { describe, expect, it, vi } from 'vitest';

/**
 * The wallet balance monitor.
 *
 * The property that matters is the direction it fails in. A monitor that
 * reports calm when it is blind manufactures confidence, which is worse than no
 * monitor at all — and this codebase has already shipped that exact defect once
 * in the risk checks, where an unreachable upstream emitted no flag and looked
 * identical to a clean result.
 *
 * The reason it watches balance rather than transaction count is not
 * preference: both company wallets have a nonce of ZERO while money has
 * demonstrably moved in both directions across them, because EIP-3009 has the
 * facilitator submit and the holder only sign. A nonce-based monitor would
 * report all-clear on a drained wallet.
 */

const PAYOUT = '0xc41c4fed450674169af002b8b3cb47bd70a1958f';
const BUDGET = '0x2E31f33744e26f3093Bc748f2B4eA1c5e3D06FC7';

/** Load the module with a controllable chain read and a fresh baseline. */
async function load(balances: Record<string, number | Error>) {
  vi.resetModules();
  vi.doMock('../src/rpc.js', () => ({
    client: {
      readContract: async ({ args }: { args: readonly unknown[] }) => {
        const addr = String(args[0]).toLowerCase();
        const v = balances[addr];
        if (v instanceof Error) throw v;
        return BigInt(Math.round((v ?? 0) * 1e6));
      },
    },
  }));
  // Keep the baseline in memory: no volume in tests.
  process.env.DATA_DIR = `/tmp/wm-${Math.random().toString(36).slice(2)}`;
  return import('../src/walletMonitor.js');
}

const set = (payout: number | Error, budget: number | Error) => ({
  [PAYOUT.toLowerCase()]: payout,
  [BUDGET.toLowerCase()]: budget,
});

describe('walletMonitor', () => {
  it('reports first_read rather than inventing a change', async () => {
    const m = await load(set(0.04, 4.98));
    m.initWalletMonitor();
    const snap = await m.checkWallets();
    expect(snap.wallets.every((w) => w.status === 'first_read')).toBe(true);
    expect(snap.wallets.every((w) => w.change_usd === null)).toBe(true);
  });

  it('sums both wallets into funds_on_hand', async () => {
    const m = await load(set(0.04, 4.98));
    m.initWalletMonitor();
    const snap = await m.checkWallets();
    expect(snap.funds_on_hand_usd).toBeCloseTo(5.02, 6);
  });

  it('flags a payout-wallet decrease as an incident', async () => {
    // Nothing in this system holds a key that can move these funds, so a
    // decrease has no benign technical explanation.
    const m = await load(set(0.04, 4.98));
    m.initWalletMonitor();
    await m.checkWallets();
    const drained = await load2(m, set(0.0, 4.98));
    const payout = drained.wallets.find((w) => w.role === 'payout')!;
    expect(payout.status).toBe('DECREASED');
    expect(payout.change_usd).toBeCloseTo(-0.04, 6);
    expect(payout.alert).toMatch(/incident/i);
    expect(drained.needs_attention).toBe(true);
  });

  it('flags a budget-wallet decrease as needing a matching expense, not as theft', async () => {
    const m = await load(set(0.04, 4.98));
    m.initWalletMonitor();
    await m.checkWallets();
    const spent = await load2(m, set(0.04, 4.0));
    const budget = spent.wallets.find((w) => w.role === 'budget')!;
    expect(budget.status).toBe('DECREASED');
    expect(budget.alert).toMatch(/logged expense|nobody recorded/i);
  });

  it('does not alert when a balance rises', async () => {
    const m = await load(set(0.04, 4.98));
    m.initWalletMonitor();
    await m.checkWallets();
    const paid = await load2(m, set(0.06, 4.98));
    expect(paid.wallets.find((w) => w.role === 'payout')!.status).toBe('increased');
    expect(paid.needs_attention).toBe(false);
  });

  it('reports an unreadable wallet as unknown, never as steady', async () => {
    // The load-bearing case. Silence must not look like a clean result.
    const m = await load(set(new Error('rpc down'), 4.98));
    m.initWalletMonitor();
    const snap = await m.checkWallets();
    const payout = snap.wallets.find((w) => w.role === 'payout')!;
    expect(payout.status).toBe('unknown');
    expect(payout.usdc).toBeNull();
    expect(payout.alert).toMatch(/UNKNOWN, not unchanged/);
    expect(snap.needs_attention).toBe(true);
  });

  it('refuses to report funds_on_hand from a partial read', async () => {
    // A partial sum is a wrong number wearing a right one's clothes.
    const m = await load(set(new Error('rpc down'), 4.98));
    m.initWalletMonitor();
    const snap = await m.checkWallets();
    expect(snap.funds_on_hand_usd).toBeNull();
  });

  it('keeps the last SUCCESSFUL read time, so blindness is measurable', async () => {
    const m = await load(set(0.04, 4.98));
    m.initWalletMonitor();
    const first = await m.checkWallets();
    const stamp = first.wallets.find((w) => w.role === 'payout')!.last_success_at;
    expect(stamp).toBeTruthy();

    const blind = await load2(m, set(new Error('rpc down'), 4.98));
    const payout = blind.wallets.find((w) => w.role === 'payout')!;
    // Not "now" — the last time we actually saw it.
    expect(payout.last_success_at).toBe(stamp);
  });
});

/** Re-read with different balances against the same in-memory baseline. */
async function load2(
  m: typeof import('../src/walletMonitor.js'),
  balances: Record<string, number | Error>,
) {
  const rpc = await import('../src/rpc.js');
  (rpc as unknown as { client: { readContract: unknown } }).client.readContract = async ({
    args,
  }: {
    args: readonly unknown[];
  }) => {
    const v = balances[String(args[0]).toLowerCase()];
    if (v instanceof Error) throw v;
    return BigInt(Math.round((v ?? 0) * 1e6));
  };
  return m.checkWallets();
}
