import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import type { DecodedEvent } from '../src/decode/events.js';
import type { TokenMeta } from '../src/decode/tokens.js';

// Stub the network-backed metadata reads; keep shortAddress etc. real.
const meta = vi.hoisted(() => ({ map: new Map<string, TokenMeta | null>() }));
vi.mock('../src/decode/tokens.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/decode/tokens.js')>();
  return {
    ...actual,
    getTokenMeta: async (a: string) => meta.map.get(a.toLowerCase()) ?? null,
    getContractName: async () => null,
  };
});

import { buildAssetsMoved } from '../src/decode/assets.js';
import { shortAddress } from '../src/decode/tokens.js';

const SENDER = '0x1111111111111111111111111111111111111111' as Address;
const OTHER = '0x2222222222222222222222222222222222222222' as Address;
const WETH = '0x4200000000000000000000000000000000000006' as Address;
const SCAM = '0x5c371cc9121a71c974091e0eb07d05d02a6915a9' as Address; // real scam token

const transfer = (emitter: Address): DecodedEvent => ({
  kind: 'erc20_transfer',
  emitter,
  args: { from: SENDER, to: OTHER, value: 7211n * 10n ** 18n },
  logIndex: 0,
});
const tx = { from: SENDER, to: OTHER, value: 0n, wethAddress: WETH, reverted: false };

beforeEach(() => meta.map.clear());

describe('buildAssetsMoved — untrusted token symbol surfacing', () => {
  it('reports a non-standard symbol and shows the address', async () => {
    meta.map.set(SCAM.toLowerCase(), { symbol: shortAddress(SCAM), decimals: 18, symbolStatus: 'nonstandard' });
    const { movements, flaggedSymbols } = await buildAssetsMoved([transfer(SCAM)], tx);
    expect(flaggedSymbols).toEqual([{ address: SCAM.toLowerCase(), status: 'nonstandard' }]);
    expect(movements[0]?.token).toBe(shortAddress(SCAM)); // address, not the scam name
  });

  it('reports an impersonation distinctly from a non-standard symbol', async () => {
    meta.map.set(SCAM.toLowerCase(), { symbol: shortAddress(SCAM), decimals: 6, symbolStatus: 'impersonation' });
    const { flaggedSymbols } = await buildAssetsMoved([transfer(SCAM)], tx);
    expect(flaggedSymbols).toEqual([{ address: SCAM.toLowerCase(), status: 'impersonation' }]);
  });

  it('does not report a token with a trusted (ok) symbol', async () => {
    meta.map.set(SCAM.toLowerCase(), { symbol: 'USDC', decimals: 6, symbolStatus: 'ok' });
    const { movements, flaggedSymbols } = await buildAssetsMoved([transfer(SCAM)], tx);
    expect(flaggedSymbols).toHaveLength(0);
    expect(movements[0]?.token).toBe('USDC');
  });
});

/**
 * A reverted transaction moves nothing. The EVM discards its logs and refunds
 * the value it carried, so reporting `tx.value` as a movement asserts a transfer
 * that provably did not happen — and contradicts `status`, the
 * `transaction_reverted` flag, and the summary's own "no assets moved", all in
 * the same response.
 */
describe('buildAssetsMoved — a reverted transaction moves nothing', () => {
  const withValue = (reverted: boolean) => ({
    from: SENDER,
    to: OTHER,
    value: 10n ** 18n, // 1 ETH attached
    wethAddress: WETH,
    reverted,
  });

  it('reports NO native movement when the transaction reverted', async () => {
    // A failed mint/swap that carried ETH: value attached, no logs, refunded.
    const { movements } = await buildAssetsMoved([], withValue(true));
    expect(movements).toEqual([]);
  });

  it('still reports the native movement when it succeeded', async () => {
    const { movements } = await buildAssetsMoved([], withValue(false));
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ token: 'ETH', amount: '1', from: SENDER, to: OTHER, standard: 'native' });
  });

  it('reports nothing for a reverted transaction even with a large value', async () => {
    const { movements, truncated } = await buildAssetsMoved([], { ...withValue(true), value: 10n ** 21n });
    expect(movements).toEqual([]);
    expect(truncated).toBe(false);
  });
});
