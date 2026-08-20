import type { Address } from 'viem';
import { getLabel, WETH_ADDRESS } from '../labels.js';
import type { ActionType, AssetMovement } from '../types.js';
import { netFlows } from './assets.js';
import type { DecodedEvent } from './events.js';
import type { SelectorHint } from './selectors.js';

export interface ClassifyInput {
  from: Address;
  to: Address | null;
  value: bigint;
  inputData: string;
  reverted: boolean;
  events: DecodedEvent[];
  movements: AssetMovement[];
  fnName: string | null;
  fnHint: SelectorHint | null;
}

export interface Classification {
  action: ActionType;
  detail: {
    fnName?: string;
    selector?: string;
    protocol?: string;
    userOpCount?: number;
    registeredName?: string;
    approvalRevoked?: boolean;
    approvalForAllGranted?: boolean;
    mintCount?: number;
    collection?: string;
  };
}

const UNLIMITED_THRESHOLD = 2n ** 128n;

/**
 * Deterministic, ordered classification. Most-specific evidence first; every
 * rule is event- or address-grounded, with function-selector hints as
 * tiebreakers only. Reverted transactions carry no logs, so they classify by
 * intent (selector + target) alone.
 */
export function classify(input: ClassifyInput): Classification {
  const { from, to, value, inputData, events, movements, fnName, fnHint } = input;
  const sender = from.toLowerCase();
  const toLabel = getLabel(to);
  const protocol = toLabel?.label;
  const detail: Classification['detail'] = {};
  if (fnName) detail.fnName = fnName;
  else if (inputData.length >= 10) detail.selector = inputData.slice(0, 10);
  if (protocol) detail.protocol = protocol;

  const has = (kind: DecodedEvent['kind']) => events.some((e) => e.kind === kind);
  const all = (kind: DecodedEvent['kind']) => events.filter((e) => e.kind === kind);

  // 1. Deployment
  if (!to) return { action: 'contract_deployment', detail };

  // 2. Account-abstraction bundles (EntryPoint)
  const userOps = all('user_operation');
  if (toLabel?.category === 'entrypoint' || userOps.length > 0 || fnHint === 'handle_ops') {
    return { action: 'account_abstraction_bundle', detail: { ...detail, userOpCount: userOps.length } };
  }

  // Reverted receipts have no logs — classify by intent, explain.ts marks the failure.
  if (input.reverted) {
    return { action: classifyIntentOnly(input), detail };
  }

  // 3. Attestations (EAS)
  if (has('eas_attested') || (toLabel?.category === 'attestation' && fnHint === 'attest')) {
    return { action: 'attestation', detail };
  }

  // 4. Name registration (Basenames / ENS-style controllers)
  const nameEv = all('name_registered')[0];
  if (nameEv || (toLabel?.category === 'registry' && fnHint === 'register')) {
    const registeredName = nameEv ? String(nameEv.args.name ?? '') : undefined;
    return { action: 'name_registration', detail: { ...detail, registeredName } };
  }

  // 5. Bridges — explicit events first, then bridge-labeled targets by flow direction
  if (has('bridge_withdrawal_initiated') || has('bridge_eth_initiated') || has('bridge_erc20_initiated')) {
    return { action: 'bridge_out', detail };
  }
  if (has('bridge_deposit_finalized') || has('bridge_eth_finalized') || has('bridge_erc20_finalized')) {
    return { action: 'bridge_in', detail };
  }
  if (toLabel?.category === 'bridge' || fnHint === 'bridge') {
    const flows = netFlows(movements, sender);
    let net = 0;
    for (const f of flows.values()) net += Math.sign(f.net);
    if (value > 0n) net -= 1;
    return { action: net >= 0 ? 'bridge_in' : 'bridge_out', detail };
  }

  // 6. Wrap / unwrap (only when WETH itself is the target)
  if (to.toLowerCase() === WETH_ADDRESS) {
    if (has('weth_deposit')) return { action: 'wrap', detail: { ...detail, protocol: 'WETH' } };
    if (has('weth_withdrawal')) return { action: 'unwrap', detail: { ...detail, protocol: 'WETH' } };
  }

  // 7. NFT sales (Seaport events, or marketplace-labeled targets moving NFTs)
  const nftMoves = movements.filter((m) => m.standard === 'erc721' || m.standard === 'erc1155');
  if (has('seaport_order') || fnHint === 'nft_trade') {
    return { action: 'nft_sale', detail: { ...detail, protocol: detail.protocol ?? 'Seaport' } };
  }
  if (toLabel?.category === 'nft_marketplace' && nftMoves.length > 0) {
    return { action: 'nft_sale', detail };
  }

  // 8. Lending (event-grounded)
  if (has('aave_supply')) return { action: 'lending_supply', detail };
  if (has('aave_borrow')) return { action: 'lending_borrow', detail };
  if (has('aave_repay')) return { action: 'lending_repay', detail };
  if (has('aave_withdraw')) return { action: 'lending_withdraw', detail };
  if (toLabel?.category === 'lending') {
    if (has('comet_supply') || fnHint === 'lending' || fnHint === 'stake') {
      const flows = netFlows(movements, sender);
      let net = 0;
      for (const f of flows.values()) net += f.net > 0 ? 1 : f.net < 0 ? -1 : 0;
      if (value > 0n) net -= 1;
      return { action: net < 0 ? 'lending_supply' : 'lending_withdraw', detail };
    }
    if (has('comet_withdraw')) return { action: 'lending_withdraw', detail };
  }

  // 8.5 Liquidity provision — checked before swaps because zap-ins emit both
  if (has('lp_increase') || has('v2_lp_mint')) {
    return { action: 'add_liquidity', detail };
  }
  if (has('lp_decrease') || has('v2_lp_burn')) {
    return { action: 'remove_liquidity', detail };
  }
  if (has('lp_collect') && !has('univ3_swap')) {
    return { action: 'claim', detail };
  }

  // 9. Swaps — recognized DEX events, then net-flow heuristic for aggregators
  const swapEvents = [...all('univ3_swap'), ...all('univ2_swap'), ...all('univ4_swap'), ...all('solidly_swap')];
  if (swapEvents.length > 0) {
    const emitterLabel = swapEvents.map((e) => getLabel(e.emitter)?.label).find(Boolean);
    return { action: 'swap', detail: { ...detail, protocol: detail.protocol ?? emitterLabel } };
  }

  // 10. NFT mints (fresh NFTs from the zero address)
  const mintedNfts = nftMoves.filter(
    (m) => m.from === '0x0000000000000000000000000000000000000000',
  );
  if (mintedNfts.length > 0 && nftMoves.length === mintedNfts.length) {
    return {
      action: 'nft_mint',
      detail: { ...detail, mintCount: mintedNfts.length, collection: mintedNfts[0]?.token },
    };
  }

  // 11. Claims / rewards
  if (fnHint === 'claim' || has('reward_paid') || has('merkle_claimed')) {
    return { action: 'claim', detail };
  }

  // 12. Staking
  if (fnHint === 'stake' && (has('staked') || toLabel?.category === 'staking')) {
    return { action: 'stake', detail };
  }
  if (fnHint === 'unstake' || (has('stake_withdrawn') && toLabel?.category === 'staking')) {
    return { action: 'unstake', detail };
  }

  // 13. Approvals (no asset movement)
  const fungibleMoves = movements.filter((m) => m.standard === 'erc20' || m.standard === 'native');
  const approvalForAll = all('approval_for_all')[0];
  if (approvalForAll && movements.length === 0) {
    const granted = Boolean(approvalForAll.args.approved);
    return granted
      ? { action: 'approval_for_all', detail: { ...detail, approvalForAllGranted: true } }
      : { action: 'approval_revoked', detail: { ...detail, approvalForAllGranted: false } };
  }
  const erc20Approvals = all('erc20_approval');
  if (erc20Approvals.length > 0 && movements.length === 0) {
    const v = erc20Approvals[0]?.args.value as bigint | undefined;
    if (v === 0n) return { action: 'approval_revoked', detail: { ...detail, approvalRevoked: true } };
    return { action: 'erc20_approval', detail };
  }

  // 14. Aggregator swaps: sender pays one fungible and receives a different one
  const flows = [...netFlows(movements, sender).entries()];
  const senderOut = flows.filter(([, f]) => f.net < -1e-12);
  const senderIn = flows.filter(([, f]) => f.net > 1e-12);
  const paidNative = value > 0n;
  if (nftMoves.some((m) => m.to.toLowerCase() === sender) && (senderOut.length > 0 || paidNative)) {
    return { action: 'nft_sale', detail };
  }
  if ((senderOut.length > 0 || paidNative) && senderIn.length > 0 && (fnHint === 'swap' || toLabel?.category === 'dex')) {
    return { action: 'swap', detail };
  }
  if (senderOut.length === 1 && senderIn.length === 1 && senderOut[0]?.[0] !== senderIn[0]?.[0] && fnHint !== 'transfer') {
    return { action: 'swap', detail };
  }

  // 15. Token mint / airdrop straight to the sender
  const erc20FromZero = movements.filter(
    (m) => m.standard === 'erc20' && m.from === '0x0000000000000000000000000000000000000000',
  );
  if (erc20FromZero.length > 0 && erc20FromZero.length === fungibleMoves.length) {
    return { action: 'token_mint', detail };
  }

  // 16. Batch payouts (disperse-style: one sender, many recipients)
  const outbound = fungibleMoves.filter((m) => m.from.toLowerCase() === sender);
  const distinctRecipients = new Set(outbound.map((m) => m.to.toLowerCase()));
  if (fnHint === 'batch_transfer' || (outbound.length >= 5 && distinctRecipients.size >= 5)) {
    return { action: 'batch_transfer', detail };
  }

  // 17. Plain transfers
  if (
    fungibleMoves.length > 0 &&
    fungibleMoves.every((m) => m.standard === 'erc20' && m.from.toLowerCase() === sender) &&
    (fnHint === 'transfer' || fungibleMoves.length === 1)
  ) {
    return { action: 'erc20_transfer', detail };
  }
  if (nftMoves.length > 0 && fungibleMoves.length === 0) {
    return { action: 'nft_transfer', detail };
  }
  // Plain sends — including 0-value empty sends (nonce-management / cancels).
  if (events.length === 0 && (inputData === '0x' || inputData === '')) {
    return { action: 'eth_transfer', detail };
  }

  // 18. Fallbacks — any call with input data is a contract interaction;
  // 'unknown' is reserved for transactions with nothing to go on at all.
  if (fnHint === 'mint' && movements.length > 0) return { action: 'token_mint', detail };
  if (movements.length > 0 || fnName || events.length > 0 || inputData.length >= 10) {
    return { action: 'contract_interaction', detail };
  }
  return { action: 'unknown', detail };
}

/** Reverted transactions: no logs, so infer what was being attempted. */
function classifyIntentOnly(input: ClassifyInput): ActionType {
  const { to, value, inputData, fnHint } = input;
  const toLabel = getLabel(to);
  switch (fnHint) {
    case 'swap':
      return 'swap';
    case 'transfer':
      return 'erc20_transfer';
    case 'approve':
      return 'erc20_approval';
    case 'set_approval_for_all':
      return 'approval_for_all';
    case 'mint':
      return 'nft_mint';
    case 'claim':
      return 'claim';
    case 'stake':
      return 'stake';
    case 'unstake':
      return 'unstake';
    case 'bridge':
      return 'bridge_out';
    case 'wrap':
      return to?.toLowerCase() === WETH_ADDRESS ? 'wrap' : 'contract_interaction';
    case 'unwrap':
      return to?.toLowerCase() === WETH_ADDRESS ? 'unwrap' : 'contract_interaction';
    case 'register':
      return 'name_registration';
    case 'nft_trade':
      return 'nft_sale';
    case 'lending':
      return toLabel?.category === 'lending' ? 'lending_supply' : 'contract_interaction';
    default:
      if (value > 0n && (inputData === '0x' || inputData === '')) return 'eth_transfer';
      return 'contract_interaction';
  }
}

/** True when an approval grants effectively unlimited spending power. */
export function isUnlimitedApproval(value: bigint): boolean {
  return value >= UNLIMITED_THRESHOLD;
}
