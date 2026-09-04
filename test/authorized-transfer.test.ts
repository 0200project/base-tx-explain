import { describe, expect, it } from 'vitest';
import { classify } from '../src/decode/classify.js';
import { buildSummary } from '../src/summary.js';
import type { DecodedEvent } from '../src/decode/events.js';
import type { Address } from 'viem';
import type { AssetMovement } from '../src/types.js';

const SUBMITTER = '0xc669000000000000000000000000000000000cb63'.slice(0, 42) as Address;
const PAYER = '0xf0c793636277356dc2c12f215e770e415957edbf' as Address;
const PAYEE = '0xc41c4fed450674169af002b8b3cb47bd70a1958f' as Address;
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'; // labeled 'token' in labels.ts
const UNLABELED = '0x9999999999999999999999999999999999999999' as Address;

const move: AssetMovement = {
  token: 'USDC', amount: '0.02', from: PAYER, to: PAYEE,
  token_address: USDC, standard: 'erc20',
};
const authEvent = (emitter: string): DecodedEvent => ({
  kind: 'authorization_used', emitter: emitter as Address, args: {}, logIndex: 0,
});
const base = {
  from: SUBMITTER, to: '0xca11bde05977b3631167028862be2a173976ca11' as Address,
  value: 0n, inputData: '0x82ad56cb', reverted: false, fnName: 'aggregate3', fnHint: null,
} as const;

/**
 * Our own customer settlements arrive as EIP-3009 authorized transfers: the
 * payer signs off-chain, a facilitator submits and pays gas. The money moves
 * from the PAYER, not from the transaction sender — so the plain-transfer
 * branch, which requires value to leave the sender, missed them entirely and
 * they classified as `contract_interaction`, summarised as
 * "called contract Multicall3 (function: aggregate3)".
 */
describe('authorized (EIP-3009) transfers', () => {
  it('classifies as a transfer even though nothing left the transaction sender', () => {
    const r = classify({ ...base, events: [authEvent(USDC)], movements: [move] });
    expect(r.action).toBe('erc20_transfer');
    expect(r.detail.authorized).toBe(true);
  });

  it('names the PAYER, not the submitter — the whole point of the branch', () => {
    const c = classify({ ...base, events: [authEvent(USDC)], movements: [move] });
    const s = buildSummary({
      classification: c, movements: [move], from: SUBMITTER, to: base.to,
      reverted: false, deployedContract: null,
    } as Parameters<typeof buildSummary>[0]);
    // The defect this replaces would have read "0xc669… sent 0.02 USDC" — the
    // submitter, who sent nothing. That sentence must never be producible here.
    // Case-insensitive: live data is checksummed, fixtures here are not, and the
    // assertion is about WHICH ADDRESS is named, never about its casing.
    expect(s.toLowerCase()).toContain('0xf0c7');
    expect(s).toContain('signed transfer authorization');
    expect(s.toLowerCase()).not.toMatch(/^0xc669\S* sent/);
  });

  it('IGNORES the event from an unlabeled contract — a forged AuthorizationUsed must not relabel a batch', () => {
    const r = classify({ ...base, events: [authEvent(UNLABELED)], movements: [move] });
    expect(r.action).not.toBe('erc20_transfer');
  });

  it('does not fire without the event', () => {
    const r = classify({ ...base, events: [], movements: [move] });
    expect(r.detail.authorized).toBeUndefined();
  });
});
