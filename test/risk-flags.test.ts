import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import type { DecodedEvent } from '../src/decode/events.js';
import type { AssetMovement, RiskFlag } from '../src/types.js';

// Controllable stand-ins for the network-backed risk lookups. hoisted so the
// vi.mock factories (which are hoisted above the imports) can close over them.
const state = vi.hoisted(() => ({
  verified: new Set<string>(), // addresses to report as verified; everything else is 'unverified'
  firstTime: new Set<string>(), // addresses for which isFirstInteraction returns true
  drainers: new Set<string>(), // addresses on the drainer blocklist
}));

vi.mock('../src/risk/verification.js', () => ({
  verificationStatus: async (addr: string) =>
    state.verified.has(addr.toLowerCase()) ? 'verified' : 'unverified',
}));
vi.mock('../src/risk/firstTime.js', () => ({
  isFirstInteraction: async (_from: string, counterparty: string) =>
    state.firstTime.has(counterparty.toLowerCase()),
}));
vi.mock('../src/risk/drainers.js', () => ({
  isKnownDrainer: async (addr: string) => state.drainers.has(addr.toLowerCase()),
}));

import { buildRiskFlags } from '../src/risk/flags.js';

// Real labeled Base addresses (getLabel is NOT mocked, so these must be genuine
// entries in src/labels.ts to exercise the "labeled address is skipped" path).
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as Address; // token
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3' as Address; // infra
const UNI_ROUTER = '0x2626664c2603336e57b271c5c0b26f421741e481' as Address; // dex (labeled)

const SENDER = '0x1111111111111111111111111111111111111111' as Address;
const ATTACKER = '0xdeadbeef00000000000000000000000000000001' as Address; // unlabeled
const UNLABELED_ROUTER = '0xabcdef0000000000000000000000000000000abc' as Address;

const approvalEvent = (spender: Address, value = 1_000_000n): DecodedEvent => ({
  kind: 'erc20_approval',
  emitter: USDC,
  args: { owner: SENDER, spender, value },
  logIndex: 0,
});

const flagCodes = (flags: RiskFlag[]) => flags.map((f) => f.flag);
const detailFor = (flags: RiskFlag[], code: string) =>
  flags.find((f) => f.flag === code)?.detail ?? '';

// shortAddress form used in the flag details.
const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

beforeEach(() => {
  state.verified.clear();
  state.firstTime.clear();
  state.drainers.clear();
});

describe('buildRiskFlags — approval trust target resolution', () => {
  it('flags an approve() to a fresh unlabeled spender even though `to` is a labeled token (the drain-precursor bug)', async () => {
    // approve(ATTACKER, amount) on USDC: `to` is the labeled token, ATTACKER is unverified and new.
    state.firstTime.add(ATTACKER.toLowerCase());

    const flags = await buildRiskFlags({
      from: SENDER,
      to: USDC, // the token contract, NOT the spender
      blockNumber: 1000n,
      reverted: false,
      classification: { action: 'erc20_approval', detail: {} },
      events: [approvalEvent(ATTACKER)],
      movements: [],
    });

    // Before the fix this returned [] because checks keyed on `to` (a labeled token).
    expect(flagCodes(flags)).toContain('unverified_contract');
    expect(flagCodes(flags)).toContain('first_time_counterparty');
    // The spender must be named in the output, not the token.
    expect(detailFor(flags, 'unverified_contract')).toContain(short(ATTACKER));
    expect(detailFor(flags, 'unverified_contract')).toContain('spender');
    expect(detailFor(flags, 'first_time_counterparty')).toContain(short(ATTACKER));
  });

  it('does not flag when the spender is a labeled address (approving Permit2 is not a first-time/unverified event)', async () => {
    state.firstTime.add(PERMIT2.toLowerCase());
    const flags = await buildRiskFlags({
      from: SENDER,
      to: USDC,
      blockNumber: 1000n,
      reverted: false,
      classification: { action: 'erc20_approval', detail: {} },
      events: [approvalEvent(PERMIT2)],
      movements: [],
    });
    expect(flagCodes(flags)).not.toContain('unverified_contract');
    expect(flagCodes(flags)).not.toContain('first_time_counterparty');
  });

  it('still checks `to` additively: an unlabeled router in an approve+swap is not blinded by the spender resolution', async () => {
    // Distinct spender (Permit2, labeled → filtered) and an unlabeled router as `to`.
    state.firstTime.add(UNLABELED_ROUTER.toLowerCase());
    const flags = await buildRiskFlags({
      from: SENDER,
      to: UNLABELED_ROUTER,
      blockNumber: 1000n,
      reverted: false,
      classification: { action: 'swap', detail: {} },
      events: [approvalEvent(PERMIT2)],
      movements: [
        { token: 'USDC', amount: '100', from: SENDER, to: UNLABELED_ROUTER, token_address: USDC, standard: 'erc20' } as AssetMovement,
      ],
    });
    expect(flagCodes(flags)).toContain('unverified_contract');
    expect(detailFor(flags, 'unverified_contract')).toContain(short(UNLABELED_ROUTER));
  });

  it('does not regress the labeled-router swap: no approval, labeled `to` → no unverified/first-time flags', async () => {
    state.firstTime.add(UNI_ROUTER.toLowerCase());
    const flags = await buildRiskFlags({
      from: SENDER,
      to: UNI_ROUTER, // labeled dex router
      blockNumber: 1000n,
      reverted: false,
      classification: { action: 'swap', detail: {} },
      events: [],
      movements: [
        { token: 'USDC', amount: '100', from: SENDER, to: UNI_ROUTER, token_address: USDC, standard: 'erc20' } as AssetMovement,
      ],
    });
    expect(flagCodes(flags)).not.toContain('unverified_contract');
    expect(flagCodes(flags)).not.toContain('first_time_counterparty');
  });

  it('surfaces a known_drainer spender on an approval', async () => {
    state.drainers.add(ATTACKER.toLowerCase());
    const flags = await buildRiskFlags({
      from: SENDER,
      to: USDC,
      blockNumber: 1000n,
      reverted: false,
      classification: { action: 'erc20_approval', detail: {} },
      events: [approvalEvent(ATTACKER)],
      movements: [],
    });
    expect(flagCodes(flags)).toContain('known_drainer');
    expect(detailFor(flags, 'known_drainer')).toContain(short(ATTACKER));
  });
});
