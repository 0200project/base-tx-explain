import type { Address } from 'viem';
import type { Classification } from '../decode/classify.js';
import { isUnlimitedApproval } from '../decode/classify.js';
import type { DecodedEvent } from '../decode/events.js';
import { shortAddress } from '../decode/tokens.js';
import { getLabel } from '../labels.js';
import type { AssetMovement, RiskFlag } from '../types.js';
import { isKnownDrainer } from './drainers.js';
import { isFirstInteraction } from './firstTime.js';
import { verificationStatus } from './verification.js';

interface FlagContext {
  from: Address;
  to: Address | null;
  blockNumber: bigint;
  reverted: boolean;
  classification: Classification;
  events: DecodedEvent[];
  movements: AssetMovement[];
}

/**
 * Assemble risk_flags. Every check degrades to "no flag" rather than an error —
 * a risk flag must always mean evidence was found, never that a lookup failed.
 */
export async function buildRiskFlags(ctx: FlagContext): Promise<RiskFlag[]> {
  const flags: RiskFlag[] = [];
  const { from, to, classification, events, movements } = ctx;
  const sender = from.toLowerCase();
  const action = classification.action;

  if (ctx.reverted) {
    flags.push({ flag: 'transaction_reverted', detail: 'The transaction reverted; no state changes took effect (gas was still paid).' });
  }

  for (const e of events) {
    if (e.kind === 'approval_for_all' && Boolean(e.args.approved)) {
      const operator = String(e.args.operator ?? '');
      const operatorLabel = getLabel(operator)?.label;
      flags.push({
        flag: 'approval_for_all',
        detail: `Granted ${operatorLabel ?? shortAddress(operator)} operator control over ALL tokens in collection ${shortAddress(e.emitter)} — this permits future transfers without further signatures.`,
      });
    }
    if (e.kind === 'erc20_approval') {
      const value = e.args.value as bigint | undefined;
      if (value !== undefined && isUnlimitedApproval(value)) {
        const spender = String(e.args.spender ?? '');
        const spenderLabel = getLabel(spender)?.label;
        flags.push({
          flag: 'unlimited_approval',
          detail: `Approved ${spenderLabel ?? shortAddress(spender)} to spend an effectively unlimited amount of token ${shortAddress(e.emitter)}.`,
        });
      }
    }
  }

  // Addresses that gained power or received the sender's assets in this tx.
  const exposedAddresses = new Set<string>();
  if (to) exposedAddresses.add(to.toLowerCase());
  for (const e of events) {
    if (e.kind === 'erc20_approval' && e.args.spender) exposedAddresses.add(String(e.args.spender).toLowerCase());
    if (e.kind === 'approval_for_all' && Boolean(e.args.approved) && e.args.operator) {
      exposedAddresses.add(String(e.args.operator).toLowerCase());
    }
  }
  for (const m of movements) {
    if (m.from.toLowerCase() === sender) exposedAddresses.add(m.to.toLowerCase());
  }

  const drainerChecks = await Promise.all(
    [...exposedAddresses].map(async (a) => ((await isKnownDrainer(a)) ? a : null)),
  );
  for (const hit of drainerChecks) {
    if (hit) {
      flags.push({
        flag: 'known_drainer',
        detail: `${shortAddress(hit)} appears on a public scam/drainer blacklist (ScamSniffer database).`,
      });
    }
  }

  // Verification + first-interaction checks only for the address being trusted,
  // and only when this tx actually extends trust (assets moved or approval granted).
  const extendsTrust =
    movements.some((m) => m.from.toLowerCase() === sender) ||
    events.some((e) => e.kind === 'erc20_approval' || (e.kind === 'approval_for_all' && Boolean(e.args.approved))) ||
    (!ctx.reverted && action === 'contract_interaction');

  if (to && extendsTrust && action !== 'eth_transfer' && !getLabel(to)) {
    const status = await verificationStatus(to);
    if (status === 'unverified') {
      flags.push({
        flag: 'unverified_contract',
        detail: `The target contract ${shortAddress(to)} has no verified source code on Sourcify${process.env.ETHERSCAN_API_KEY ? ' or Basescan' : ''}.`,
      });
    }

    const first = await isFirstInteraction(from, to, ctx.blockNumber);
    if (first === true) {
      flags.push({
        flag: 'first_time_counterparty',
        detail: `This is the sender's first recorded transaction with ${shortAddress(to)} on Base.`,
      });
    }
  }

  return flags;
}
