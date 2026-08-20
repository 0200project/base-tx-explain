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
const tx = { from: SENDER, to: OTHER, value: 0n, wethAddress: WETH };

beforeEach(() => meta.map.clear());

describe('buildAssetsMoved — nonstandard token symbol surfacing', () => {
  it('reports a token whose symbol is not a standard ticker and shows the address', async () => {
    // getTokenMeta already resolves the display symbol to the address for a
    // non-ticker name and marks standardSymbol:false.
    meta.map.set(SCAM.toLowerCase(), { symbol: shortAddress(SCAM), decimals: 18, standardSymbol: false });
    const { movements, nonStandardSymbols } = await buildAssetsMoved([transfer(SCAM)], tx);
    expect(nonStandardSymbols.map((a) => a.toLowerCase())).toContain(SCAM.toLowerCase());
    expect(movements[0]?.token).toBe(shortAddress(SCAM)); // address, not the scam name
  });

  it('does not report a token with a standard ticker', async () => {
    meta.map.set(SCAM.toLowerCase(), { symbol: 'USDC', decimals: 6, standardSymbol: true });
    const { movements, nonStandardSymbols } = await buildAssetsMoved([transfer(SCAM)], tx);
    expect(nonStandardSymbols).toHaveLength(0);
    expect(movements[0]?.token).toBe('USDC');
  });
});
