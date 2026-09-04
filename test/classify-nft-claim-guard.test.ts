import { describe, expect, it } from 'vitest';
import { classify } from '../src/decode/classify.js';
import type { Address } from 'viem';
import type { AssetMovement } from '../src/types.js';

const SENDER = '0x1111111111111111111111111111111111111111' as Address;
const ATTACKER = '0x9999999999999999999999999999999999999999' as Address;
const COLLECTION = '0x5555555555555555555555555555555555555555';

const base = {
  from: SENDER,
  to: ATTACKER,
  value: 0n,
  inputData: '0x12345678',
  reverted: false,
  events: [],
  movements: [] as AssetMovement[],
  fnName: 'claim',
  fnHint: 'claim' as const,
} as const;

const nft = (over: Partial<AssetMovement>): AssetMovement => ({
  token: 'PUNK',
  amount: '1',
  from: SENDER,
  to: ATTACKER,
  token_address: COLLECTION,
  token_id: '42',
  standard: 'erc721',
  ...over,
});

/**
 * The guard at classify.ts:188 exists so a drainer whose entrypoint is named
 * `claim()` cannot borrow the selector hint and be summarised as a reward.
 *
 * It read `senderSent` off `netFlows`, which skips erc721/erc1155 — so an
 * NFT-only outflow produced no flow entry, `senderSent` stayed false with
 * `value` at 0, and the drain satisfied the guard. NFT approval drains are the
 * canonical claim-named attack, so the guard was blind to exactly the asset
 * class it was written for.
 *
 * Both directions are asserted deliberately: a fix that simply stopped
 * classifying claims would pass the first test and fail the second, so the pair
 * cannot be satisfied by disarming the guard.
 */
describe('claim guard sees NFT outflows', () => {
  it('an NFT leaving the sender under claim() is NOT summarised as a claim', () => {
    const r = classify({ ...base, movements: [nft({ from: SENDER, to: ATTACKER })] });
    expect(r.action).not.toBe('claim');
  });

  it('an ERC-1155 leaving the sender under claim() is NOT summarised as a claim', () => {
    const r = classify({
      ...base,
      movements: [nft({ from: SENDER, to: ATTACKER, standard: 'erc1155', amount: '3' })],
    });
    expect(r.action).not.toBe('claim');
  });

  it('a real claim — an NFT ARRIVING at the sender — is still a claim', () => {
    const r = classify({ ...base, movements: [nft({ from: ATTACKER, to: SENDER })] });
    expect(r.action).toBe('claim');
  });

  it('a claim with no asset movement at all is still a claim', () => {
    const r = classify({ ...base, movements: [] });
    expect(r.action).toBe('claim');
  });
});
