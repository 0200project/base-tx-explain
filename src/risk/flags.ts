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

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

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

  // Resolve the address(es) this tx actually extends trust TO. For an approval
  // that is the spender/operator, NOT `to` (which is the token contract) —
  // otherwise a drain-enabling approve() to a fresh, unverified attacker
  // contract is never checked, and is skipped outright when the token is
  // labeled (e.g. USDC). `to` still matters for the call itself (e.g. an
  // unverified router in an approve+swap), so include BOTH — spenders first so
  // they win the CHECK_CAP when a tx has many.
  const targets: Array<{ addr: string; role: 'spender' | 'contract' }> = [];
  const seen = new Set<string>();
  const addTarget = (raw: string | undefined | null, role: 'spender' | 'contract') => {
    if (!raw) return;
    const lower = raw.toLowerCase();
    if (seen.has(lower)) return;
    seen.add(lower);
    targets.push({ addr: lower, role });
  };
  for (const e of events) {
    if (e.kind === 'erc20_approval' && e.args.spender) addTarget(String(e.args.spender), 'spender');
    if (e.kind === 'approval_for_all' && Boolean(e.args.approved) && e.args.operator) {
      addTarget(String(e.args.operator), 'spender');
    }
  }
  if (to && extendsTrust && action !== 'eth_transfer') addTarget(to, 'contract');

  // Only unfamiliar addresses warrant a lookup: skip the sender, the zero
  // address, and anything already labeled as known infrastructure. Cap the
  // number of upstream checks so a crafted tx cannot fan out unboundedly.
  const CHECK_CAP = 3;
  const toCheck = targets
    .filter((t) => t.addr !== sender && t.addr !== ZERO_ADDRESS && !getLabel(t.addr))
    .slice(0, CHECK_CAP);

  // Run the lookups concurrently but emit flags in a deterministic order
  // (toCheck order, unverified before first_time per address).
  const trustResults = await Promise.all(
    toCheck.map(async (t) => {
      const address = t.addr as Address;
      const [status, first] = await Promise.all([
        verificationStatus(address),
        isFirstInteraction(from, address, ctx.blockNumber),
      ]);
      return { ...t, status, first };
    }),
  );
  for (const { addr, role, status, first } of trustResults) {
    const noun = role === 'spender' ? 'Approved spender' : 'Target contract';
    if (status === 'unverified') {
      flags.push({
        flag: 'unverified_contract',
        detail: `${noun} ${shortAddress(addr)} has no verified source code on Sourcify${process.env.ETHERSCAN_API_KEY ? ' or Basescan' : ''}.`,
      });
    }
    if (first === true) {
      const what = role === 'spender' ? 'approved spender' : 'counterparty';
      flags.push({
        flag: 'first_time_counterparty',
        detail: `This is the sender's first recorded transaction with ${what} ${shortAddress(addr)} on Base.`,
      });
    }
  }

  return flags;
}
