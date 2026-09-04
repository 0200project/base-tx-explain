import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import type { DecodedEvent } from '../src/decode/events.js';
import type { AssetMovement } from '../src/types.js';

// Controllable stand-ins for the network-backed risk lookups. hoisted so the
// vi.mock factories (which are hoisted above the imports) can close over them.
const state = vi.hoisted(() => ({
  verified: new Set<string>(), // addresses to report as verified; everything else is 'unverified'
  firstTime: new Set<string>(), // addresses for which isFirstInteraction returns true
  drainers: new Set<string>(), // addresses on the drainer blocklist
  supply: new Map<string, bigint | null>(), // token address -> totalSupply (null = read failed)
  // Upstream outages, so the coverage reporting can be exercised.
  verificationDown: false, // Sourcify/Basescan unreachable -> 'unknown'
  historyDown: false, // Blockscout/Basescan unreachable -> { kind: 'unreachable' }
  // Counterparties whose history lookup reports one kind of no-answer or the other.
  // Truncation is really a property of the SENDER (their history is longer than the
  // page the lookup reads), so in production every counterparty in one transaction
  // truncates together; keying it per counterparty here is only so the roll-up's
  // mixed cases can be exercised.
  truncatedFor: new Set<string>(), // -> { kind: 'truncated' }
  unreachableFor: new Set<string>(), // -> { kind: 'unreachable' }, without a global outage
  drainerListDown: false, // blacklist never loaded
  drainerAgeMs: 0,
  drainerSources: { ok: 2, tried: 2 } as { ok: number; tried: number }, // how long since the blacklist last actually rebuilt
}));

vi.mock('../src/risk/verification.js', () => ({
  verificationStatus: async (addr: string) =>
    state.verificationDown ? 'unknown' : state.verified.has(addr.toLowerCase()) ? 'verified' : 'unverified',
}));
vi.mock('../src/risk/firstTime.js', () => ({
  isFirstInteraction: async (_from: string, counterparty: string) => {
    const c = counterparty.toLowerCase();
    if (state.historyDown || state.unreachableFor.has(c)) return { kind: 'unreachable' };
    if (state.truncatedFor.has(c)) return { kind: 'truncated' };
    return state.firstTime.has(c) ? { kind: 'first' } : { kind: 'seen' };
  },
}));
vi.mock('../src/risk/drainers.js', () => ({
  isKnownDrainer: async (addr: string) =>
    !state.drainerListDown && state.drainers.has(addr.toLowerCase()),
  drainerListLoaded: () => !state.drainerListDown,
  drainerListAgeMs: () => (state.drainerListDown ? null : state.drainerAgeMs),
  // How many blacklist sources answered on the last refresh. A merge that lost
  // one still produces a non-empty set, so this is the only signal that
  // distinguishes full coverage from half of it.
  drainerSourceHealth: () => state.drainerSources,
  DRAINER_REFRESH_MS: 12 * 60 * 60 * 1000,
}));
// Partial mock: keep the real shortAddress/sanitizeSymbol, stub the network read.
vi.mock('../src/decode/tokens.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/decode/tokens.js')>();
  return {
    ...actual,
    getTokenSupply: async (addr: string) => state.supply.get(addr.toLowerCase()) ?? null,
  };
});

import { buildRiskFlags, type RiskAssessment } from '../src/risk/flags.js';

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

const flagCodes = (r: RiskAssessment) => r.flags.map((f) => f.flag);
const detailFor = (r: RiskAssessment, code: string) =>
  r.flags.find((f) => f.flag === code)?.detail ?? '';

// shortAddress form used in the flag details.
const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

beforeEach(() => {
  state.verified.clear();
  state.firstTime.clear();
  state.drainers.clear();
  state.supply.clear();
  state.truncatedFor.clear();
  state.unreachableFor.clear();
  state.verificationDown = false;
  state.historyDown = false;
  state.drainerListDown = false;
  state.drainerAgeMs = 0;
  state.drainerSources = { ok: 2, tried: 2 };
});

describe('buildRiskFlags — approval trust target resolution', () => {
  it('flags an approve() to a fresh unlabeled spender even though `to` is a labeled token (the drain-precursor bug)', async () => {
    // approve(ATTACKER, amount) on USDC: `to` is the labeled token, ATTACKER is unverified and new.
    state.firstTime.add(ATTACKER.toLowerCase());

    const res = await buildRiskFlags({
      from: SENDER,
      to: USDC, // the token contract, NOT the spender
      blockNumber: 1000n,
      reverted: false,
      classification: { action: 'erc20_approval', detail: {} },
      events: [approvalEvent(ATTACKER)],
      movements: [],
    });

    // Before the fix this returned [] because checks keyed on `to` (a labeled token).
    expect(flagCodes(res)).toContain('unverified_contract');
    expect(flagCodes(res)).toContain('first_time_counterparty');
    // The spender must be named in the output, not the token.
    expect(detailFor(res, 'unverified_contract')).toContain(short(ATTACKER));
    expect(detailFor(res, 'unverified_contract')).toContain('spender');
    expect(detailFor(res, 'first_time_counterparty')).toContain(short(ATTACKER));
  });

  it('does not flag when the spender is a labeled address (approving Permit2 is not a first-time/unverified event)', async () => {
    state.firstTime.add(PERMIT2.toLowerCase());
    const res = await buildRiskFlags({
      from: SENDER,
      to: USDC,
      blockNumber: 1000n,
      reverted: false,
      classification: { action: 'erc20_approval', detail: {} },
      events: [approvalEvent(PERMIT2)],
      movements: [],
    });
    expect(flagCodes(res)).not.toContain('unverified_contract');
    expect(flagCodes(res)).not.toContain('first_time_counterparty');
  });

  it('still checks `to` additively: an unlabeled router in an approve+swap is not blinded by the spender resolution', async () => {
    // Distinct spender (Permit2, labeled → filtered) and an unlabeled router as `to`.
    state.firstTime.add(UNLABELED_ROUTER.toLowerCase());
    const res = await buildRiskFlags({
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
    expect(flagCodes(res)).toContain('unverified_contract');
    expect(detailFor(res, 'unverified_contract')).toContain(short(UNLABELED_ROUTER));
  });

  it('does not regress the labeled-router swap: no approval, labeled `to` → no unverified/first-time flags', async () => {
    state.firstTime.add(UNI_ROUTER.toLowerCase());
    const res = await buildRiskFlags({
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
    expect(flagCodes(res)).not.toContain('unverified_contract');
    expect(flagCodes(res)).not.toContain('first_time_counterparty');
  });

  it('surfaces a known_drainer spender on an approval', async () => {
    state.drainers.add(ATTACKER.toLowerCase());
    const res = await buildRiskFlags({
      from: SENDER,
      to: USDC,
      blockNumber: 1000n,
      reverted: false,
      classification: { action: 'erc20_approval', detail: {} },
      events: [approvalEvent(ATTACKER)],
      movements: [],
    });
    expect(flagCodes(res)).toContain('known_drainer');
    expect(detailFor(res, 'known_drainer')).toContain(short(ATTACKER));
  });
});

describe('buildRiskFlags — unlimited_approval via totalSupply', () => {
  const approve = (value: bigint) =>
    buildRiskFlags({
      from: SENDER,
      to: USDC,
      blockNumber: 1000n,
      reverted: false,
      classification: { action: 'erc20_approval', detail: {} },
      events: [approvalEvent(ATTACKER, value)],
      movements: [],
    });

  it('flags an approval at or above the token total supply', async () => {
    state.supply.set(USDC.toLowerCase(), 1_000_000_000n);
    const res = await approve(1_000_000_000n);
    expect(flagCodes(res)).toContain('unlimited_approval');
    expect(detailFor(res, 'unlimited_approval')).toContain('circulating supply');
  });

  it('does NOT flag a bounded approval below total supply', async () => {
    state.supply.set(USDC.toLowerCase(), 1_000_000_000n);
    const res = await approve(1_000n);
    expect(flagCodes(res)).not.toContain('unlimited_approval');
  });

  it('catches the 2^128-1 evasion when supply is known (the old fixed-threshold gap)', async () => {
    // 2^128 - 1 slips under the old `value >= 2^128` rule, but it is astronomically
    // larger than any real token supply, so the supply comparison still flags it.
    state.supply.set(USDC.toLowerCase(), 1_000_000n);
    const res = await approve(2n ** 128n - 1n);
    expect(flagCodes(res)).toContain('unlimited_approval');
  });

  it('falls back to the 2^128 rule when the supply read is unavailable', async () => {
    // supply unknown (null) → old behavior: >= 2^128 flags, 2^128-1 does not.
    const atThreshold = await approve(2n ** 128n);
    expect(flagCodes(atThreshold)).toContain('unlimited_approval');
    const belowThreshold = await approve(2n ** 128n - 1n);
    expect(flagCodes(belowThreshold)).not.toContain('unlimited_approval');
  });
});

describe('buildRiskFlags — check coverage (D-003)', () => {
  const approvalToAttacker = () =>
    buildRiskFlags({
      from: SENDER,
      to: USDC,
      blockNumber: 1000n,
      reverted: false,
      classification: { action: 'erc20_approval', detail: {} },
      events: [approvalEvent(ATTACKER)],
      movements: [],
    });

  it('reports ok when every lookup answered', async () => {
    state.verified.add(ATTACKER.toLowerCase());
    const res = await approvalToAttacker();
    expect(res.checks.contract_verification).toBe('ok');
    expect(res.checks.first_interaction).toBe('ok');
    expect(res.checks.drainer_blacklist).toBe('ok');
    expect(res.checks.note).toBeNull();
  });

  it('an empty risk_flags from a total outage is reported as unavailable, not clean', async () => {
    // The dangerous case: every upstream is down, so no flag is emitted for an
    // address we know nothing about. Without `checks` this is byte-identical to
    // a transaction that was checked and found clean.
    state.verificationDown = true;
    state.historyDown = true;
    state.drainerListDown = true;

    const res = await approvalToAttacker();

    expect(res.flags.filter((f) => f.flag === 'unverified_contract')).toHaveLength(0);
    expect(res.flags.filter((f) => f.flag === 'first_time_counterparty')).toHaveLength(0);
    expect(res.checks.contract_verification).toBe('unavailable');
    expect(res.checks.first_interaction).toBe('unavailable');
    expect(res.checks.drainer_blacklist).toBe('unavailable');
    expect(res.checks.note).toContain('not as clean');
  });

  it('reports the blacklist separately from the other two', async () => {
    // Exactly the live production case at the time this was written: Blockscout
    // was 500ing, so counterparty history could not be checked, while Sourcify
    // and the blacklist were both fine.
    state.historyDown = true;
    state.verified.add(ATTACKER.toLowerCase());

    const res = await approvalToAttacker();
    expect(res.checks.contract_verification).toBe('ok');
    expect(res.checks.first_interaction).toBe('unavailable');
    expect(res.checks.drainer_blacklist).toBe('ok');
    expect(res.checks.note).toContain('counterparty history could not be checked');
    expect(res.checks.note).not.toContain('source-code verification');
  });

  it('reports partial when CHECK_CAP drops addresses, so padding cannot manufacture full coverage', async () => {
    // Four unfamiliar spenders, only three are looked at. Reporting `ok` here
    // would let an attacker pad a transaction to push the real target past the
    // cap and still have the output claim complete coverage.
    const spenders = [
      '0xaaaa000000000000000000000000000000000001',
      '0xbbbb000000000000000000000000000000000002',
      '0xcccc000000000000000000000000000000000003',
      '0xdddd000000000000000000000000000000000004',
    ] as Address[];
    for (const s of spenders) state.verified.add(s.toLowerCase());

    const res = await buildRiskFlags({
      from: SENDER,
      to: USDC,
      blockNumber: 1000n,
      reverted: false,
      classification: { action: 'erc20_approval', detail: {} },
      events: spenders.map((s, i) => ({ ...approvalEvent(s), logIndex: i })),
      movements: [],
    });

    expect(res.checks.contract_verification).toBe('partial');
    expect(res.checks.first_interaction).toBe('partial');
    expect(res.checks.note).toContain('only some addresses');
  });

  it('reports not_applicable when there was nothing to check', async () => {
    const res = await buildRiskFlags({
      from: SENDER,
      to: null,
      blockNumber: 1000n,
      reverted: false,
      classification: { action: 'eth_transfer', detail: {} },
      events: [],
      movements: [],
    });
    expect(res.checks.contract_verification).toBe('not_applicable');
    expect(res.checks.first_interaction).toBe('not_applicable');
    expect(res.checks.drainer_blacklist).toBe('not_applicable');
    expect(res.checks.note).toBeNull();
  });
});

describe('buildRiskFlags — coverage cannot be gamed', () => {
  const junkSpenders = [
    '0xaaaa000000000000000000000000000000000001',
    '0xbbbb000000000000000000000000000000000002',
    '0xcccc000000000000000000000000000000000003',
  ] as Address[];

  it('does not upgrade an all-indeterminate result to partial when addresses were dropped', async () => {
    // Four unfamiliar spenders, three looked at, all three indeterminate: we
    // learned nothing. Reporting `partial` here — better than the `unavailable`
    // the same outcome earns with three spenders — would mean adding an
    // unchecked address improves the reported status.
    state.verificationDown = true;
    state.historyDown = true;
    const spenders = [...junkSpenders, ATTACKER];

    const res = await buildRiskFlags({
      from: SENDER,
      to: USDC,
      blockNumber: 1000n,
      reverted: false,
      classification: { action: 'erc20_approval', detail: {} },
      events: spenders.map((s, i) => ({ ...approvalEvent(s), logIndex: i })),
      movements: [],
    });

    expect(res.checks.contract_verification).toBe('unavailable');
    expect(res.checks.first_interaction).toBe('unavailable');
  });

  it('names the addresses that were never looked at', async () => {
    const spenders = [...junkSpenders, ATTACKER];
    for (const s of spenders) state.verified.add(s.toLowerCase());

    const res = await buildRiskFlags({
      from: SENDER,
      to: USDC,
      blockNumber: 1000n,
      reverted: false,
      classification: { action: 'erc20_approval', detail: {} },
      events: spenders.map((s, i) => ({ ...approvalEvent(s), logIndex: i })),
      movements: [],
    });

    expect(res.checks.unchecked_addresses).toHaveLength(1);
    expect(res.checks.note).toContain('unchecked_addresses');
  });

  it('an unlimited approval outranks junk approvals padded ahead of it', async () => {
    // The padding attack: three counterfeit Approval events naming junk
    // spenders, emitted before the real drain-enabling one. In event order the
    // real spender falls past CHECK_CAP and is never verified. Sorting unbounded
    // approvals first keeps it in the checked set.
    state.supply.set(USDC.toLowerCase(), 1_000_000n);
    state.firstTime.add(ATTACKER.toLowerCase());

    const events: DecodedEvent[] = [
      ...junkSpenders.map((s, i) => ({ ...approvalEvent(s, 1n), logIndex: i })),
      { ...approvalEvent(ATTACKER, 2n ** 200n), logIndex: 3 },
    ];

    const res = await buildRiskFlags({
      from: SENDER,
      to: USDC,
      blockNumber: 1000n,
      reverted: false,
      classification: { action: 'erc20_approval', detail: {} },
      events,
      movements: [],
    });

    expect(flagCodes(res)).toContain('unverified_contract');
    expect(detailFor(res, 'unverified_contract')).toContain(short(ATTACKER));
    expect(res.checks.unchecked_addresses).not.toContain(ATTACKER.toLowerCase());
  });

  it('a blacklist that lost one of its sources is not reported as ok', async () => {
    // ⚠️ THE MERGED SET STAYS NON-EMPTY WHEN ONE SOURCE FAILS. refresh() merges
    // with Promise.allSettled and skips rejections silently, so `loaded` and
    // `age` both read healthy while roughly half the coverage is missing. If
    // ScamSniffer started 404ing, MyEtherWallet alone would keep answering and
    // the check would keep saying `ok`.
    //
    // Same defect as the fossil source in its other form: that one was LIVE BUT
    // FROZEN, this one is ABSENT BUT COVERED FOR. Both let a degraded check
    // answer clean.
    state.drainerSources = { ok: 1, tried: 2 };
    state.verified.add(ATTACKER.toLowerCase());

    const res = await buildRiskFlags({
      from: SENDER,
      to: USDC,
      blockNumber: 1000n,
      reverted: false,
      classification: { action: 'erc20_approval', detail: {} },
      events: [approvalEvent(ATTACKER)],
      movements: [],
    });
    expect(res.checks.drainer_blacklist).toBe('partial');
  });

  it('a blacklist older than its refresh interval is not reported as ok', async () => {
    state.drainerAgeMs = 30 * 60 * 60 * 1000; // 30 hours
    state.verified.add(ATTACKER.toLowerCase());

    const res = await buildRiskFlags({
      from: SENDER,
      to: USDC,
      blockNumber: 1000n,
      reverted: false,
      classification: { action: 'erc20_approval', detail: {} },
      events: [approvalEvent(ATTACKER)],
      movements: [],
    });

    expect(res.checks.drainer_blacklist).toBe('partial');
    expect(res.checks.note).toContain('30 hours');
  });
});

describe('buildRiskFlags — a truncated history is not an outage', () => {
  const approvalTo = (spenders: Address[]) =>
    buildRiskFlags({
      from: SENDER,
      to: USDC,
      blockNumber: 1000n,
      reverted: false,
      classification: { action: 'erc20_approval', detail: {} },
      events: spenders.map((s, i) => ({ ...approvalEvent(s), logIndex: i })),
      movements: [],
    });

  it('reports inconclusive, not unavailable, when the sender has more history than the check reads', async () => {
    // Nothing failed here: Blockscout answered, and the answer was a full page.
    // Calling that `unavailable` blames our infrastructure for a limit of the
    // method, and sends the caller back to retry a question that cannot be
    // answered this way — on exactly the high-activity wallets agents ask about.
    state.truncatedFor.add(ATTACKER.toLowerCase());
    state.verified.add(ATTACKER.toLowerCase());

    const res = await approvalTo([ATTACKER]);

    expect(res.checks.first_interaction).toBe('inconclusive');
    expect(res.checks.contract_verification).toBe('ok');
    // Still no flag: an unanswerable check never produces evidence.
    expect(flagCodes(res)).not.toContain('first_time_counterparty');
    expect(res.checks.note).toContain('more transaction history than this check reads');
    expect(res.checks.note).toContain('not as clean');
    // The one thing it must not say is that a lookup failed.
    expect(res.checks.note).not.toContain('could not be checked');
  });

  it('reports unavailable when even one indeterminate answer is a failed lookup', async () => {
    // Mixed: one truncated, one unreachable, nothing usable. `unavailable` is the
    // honest roll-up — a retry may still learn something about the second address.
    const other = '0xaaaa000000000000000000000000000000000001' as Address;
    state.truncatedFor.add(ATTACKER.toLowerCase());
    state.unreachableFor.add(other.toLowerCase());

    const res = await approvalTo([ATTACKER, other]);

    expect(res.checks.first_interaction).toBe('unavailable');
    expect(res.checks.note).toContain('counterparty history could not be checked');
  });

  it('reports partial when a truncated answer sits alongside a real one', async () => {
    const other = '0xaaaa000000000000000000000000000000000001' as Address;
    state.truncatedFor.add(ATTACKER.toLowerCase());
    state.firstTime.add(other.toLowerCase());

    const res = await approvalTo([ATTACKER, other]);

    expect(res.checks.first_interaction).toBe('partial');
    expect(flagCodes(res)).toContain('first_time_counterparty');
    expect(detailFor(res, 'first_time_counterparty')).toContain(short(other));
  });
});

/**
 * Second-order effect of the phantom-ETH bug: the synthetic native movement made
 * `extendsTrust` true on a reverted transaction, which fired verificationStatus
 * (Sourcify) and isFirstInteraction (a 1000-row Blockscout fetch) on a call where
 * no trust was extended — and could emit first_time_counterparty for it. With the
 * movement gone, a reverted transaction extends no trust and does no lookups.
 */
describe('buildRiskFlags — a reverted transaction extends no trust', () => {
  it('emits no unverified/first-time flags and does not treat the target as trusted', async () => {
    state.firstTime.add(ATTACKER.toLowerCase()); // would fire if the check ran
    const res = await buildRiskFlags({
      from: SENDER,
      to: ATTACKER, // unlabeled, unverified, never seen before
      blockNumber: 1000n,
      reverted: true,
      classification: { action: 'contract_interaction', detail: {} },
      events: [], // a reverted receipt carries no logs
      movements: [], // and now carries no phantom native movement either
    });
    expect(flagCodes(res)).toContain('transaction_reverted');
    expect(flagCodes(res)).not.toContain('unverified_contract');
    expect(flagCodes(res)).not.toContain('first_time_counterparty');
    // Nothing was eligible, so the checks report not_applicable rather than a
    // coverage gap — we did not fail to look, there was nothing to look at.
    expect(res.checks.contract_verification).toBe('not_applicable');
    expect(res.checks.first_interaction).toBe('not_applicable');
  });
});
