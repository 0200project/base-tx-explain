import { formatEther, isHex, type Address, type Hex, type TransactionReceipt } from 'viem';
import { buildAssetsMoved } from './decode/assets.js';
import { classify } from './decode/classify.js';
import { getVerifiedEventNames } from './decode/abiEvents.js';
import { decodeKnownLog, type DecodedEvent } from './decode/events.js';
import { lookupSelector } from './decode/selectors.js';
import { getTokenMeta, shortAddress } from './decode/tokens.js';
import { getLabel, WETH_ADDRESS } from './labels.js';
import { ethUsdAtBlock } from './price.js';
import { buildRiskFlags } from './risk/flags.js';
import { client } from './rpc.js';
import { buildSummary } from './summary.js';
import type { Counterparty, ExplainResult } from './types.js';

export class ExplainError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_hash' | 'not_found' | 'pending' | 'upstream_error',
  ) {
    super(message);
  }
}

const ZERO = '0x0000000000000000000000000000000000000000';
const MAX_COUNTERPARTIES = 10;

export async function explainTransaction(txHashRaw: string): Promise<ExplainResult> {
  const txHash = txHashRaw.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) {
    throw new ExplainError(
      'tx_hash must be a 66-character hex transaction hash (0x + 64 hex chars).',
      'invalid_hash',
    );
  }
  const hash = txHash as Hex;

  // "Not found" must mean the chain says so — an RPC failure (rate limit,
  // timeout) is a different, retryable answer.
  const notFound = (e: unknown) =>
    e instanceof Error &&
    (e.name === 'TransactionNotFoundError' ||
      e.name === 'TransactionReceiptNotFoundError' ||
      /could not be found/i.test(e.message ?? ''));

  // One in-process retry: public RPCs shed load transiently, and a paid call
  // must not fail on a hiccup the next attempt would absorb.
  const withRetry = async <T>(fn: () => Promise<T>): Promise<PromiseSettledResult<T>> => {
    try {
      return { status: 'fulfilled', value: await fn() };
    } catch (first) {
      if (notFound(first)) return { status: 'rejected', reason: first };
      await new Promise((r) => setTimeout(r, 500));
      try {
        return { status: 'fulfilled', value: await fn() };
      } catch (second) {
        return { status: 'rejected', reason: second };
      }
    }
  };

  const [txRes, receiptRes] = await Promise.all([
    withRetry(() => client.getTransaction({ hash })),
    withRetry(() => client.getTransactionReceipt({ hash })),
  ]);
  const tx = txRes.status === 'fulfilled' ? txRes.value : null;
  const receipt = receiptRes.status === 'fulfilled' ? receiptRes.value : null;

  if (!tx && !receipt) {
    if (notFound(txRes.status === 'rejected' ? txRes.reason : null)) {
      throw new ExplainError(
        'Transaction not found on Base mainnet. Check the hash — this tool only covers Base (chain id 8453).',
        'not_found',
      );
    }
    throw new ExplainError('Upstream RPC error while fetching the transaction; retry shortly.', 'upstream_error');
  }
  if (tx && !receipt) {
    if (notFound(receiptRes.status === 'rejected' ? receiptRes.reason : null)) {
      throw new ExplainError(
        'Transaction exists but has no receipt yet (pending). Retry in a few seconds.',
        'pending',
      );
    }
    throw new ExplainError('Upstream RPC error while fetching the receipt; retry shortly.', 'upstream_error');
  }
  if (!tx || !receipt) {
    throw new ExplainError('Upstream RPC returned inconsistent data; retry shortly.', 'upstream_error');
  }

  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  const reverted = receipt.status === 'reverted';

  // --- Decode logs into known events ---
  const events: DecodedEvent[] = [];
  const undecodedLogs: typeof receipt.logs = [];
  for (const log of receipt.logs) {
    const decoded = decodeKnownLog(log);
    if (decoded) events.push(decoded);
    else undecodedLogs.push(log);
  }

  // Name what we can't decode: verified ABIs from Sourcify give event names
  // for app-specific contracts (cached per contract, max 3 lookups per tx).
  let namedEvents: string[] = [];
  let unnamedCount = 0;
  if (undecodedLogs.length > 0) {
    const emitters = [...new Set(undecodedLogs.map((l) => l.address.toLowerCase()))].slice(0, 3);
    const nameMaps = new Map(
      await Promise.all(
        emitters.map(async (a) => [a, await getVerifiedEventNames(a as Address)] as const),
      ),
    );
    const names = new Set<string>();
    for (const log of undecodedLogs) {
      const name = log.topics[0] ? nameMaps.get(log.address.toLowerCase())?.get(log.topics[0]) : undefined;
      if (name) names.add(name);
      else unnamedCount++;
    }
    namedEvents = [...names].slice(0, 6);
  }

  // --- Function selector ---
  const inputData = tx.input ?? '0x';
  const selector =
    isHex(inputData) && inputData.length >= 10 ? ((inputData.slice(0, 10) as Hex)) : null;
  const selectorInfo = selector ? await lookupSelector(selector) : null;

  // --- Asset movements ---
  const { movements, truncated } = await buildAssetsMoved(events, {
    from: tx.from,
    to: tx.to ?? null,
    value: tx.value,
    wethAddress: WETH_ADDRESS as Address,
  });

  // --- Classify ---
  const classification = classify({
    from: tx.from,
    to: tx.to ?? null,
    value: tx.value,
    inputData,
    reverted,
    events,
    movements,
    fnName: selectorInfo?.name ?? null,
    fnHint: selectorInfo?.hint ?? null,
  });

  // --- Risk flags + gas price (independent; run together) ---
  const [riskFlags, ethUsd] = await Promise.all([
    buildRiskFlags({
      from: tx.from,
      to: tx.to ?? null,
      blockNumber: receipt.blockNumber,
      reverted,
      classification,
      events,
      movements,
    }),
    ethUsdAtBlock(receipt.blockNumber),
  ]);

  // --- Gas in USD (execution fee + OP-stack L1 data fee) ---
  const l1Fee = (receipt as TransactionReceipt & { l1Fee?: bigint | null }).l1Fee ?? 0n;
  const totalFeeWei = receipt.gasUsed * receipt.effectiveGasPrice + l1Fee;
  const gasPaidUsd =
    ethUsd === null ? null : round6(Number.parseFloat(formatEther(totalFeeWei)) * ethUsd);

  // --- Counterparties ---
  const counterparties = await buildCounterparties(tx.from, tx.to ?? null, movements, events);

  // Partial only when the transaction's meaning genuinely could not be
  // established: nothing decoded, nothing named, nothing moved.
  const partial =
    truncated ||
    (!reverted &&
      unnamedCount > 0 &&
      events.length === 0 &&
      movements.length === 0 &&
      namedEvents.length === 0);

  // Approvals name no assets in movements; resolve the token's symbol for the summary.
  let approvalTokenSymbol: string | null = null;
  if (
    (classification.action === 'erc20_approval' || classification.action === 'approval_revoked') &&
    tx.to &&
    !getLabel(tx.to)
  ) {
    approvalTokenSymbol = (await getTokenMeta(tx.to))?.symbol ?? null;
  }

  // Name the actual spender in the summary, not just "a spender": for an ERC-20
  // approval the risky party is the approved address, and it appears nowhere
  // else in the human-readable output.
  let approvalSpender: string | null = null;
  if (classification.action === 'erc20_approval') {
    const appr = events.find((e) => e.kind === 'erc20_approval');
    approvalSpender = appr ? String(appr.args.spender ?? '') || null : null;
  }

  let summary = buildSummary({
    classification,
    movements,
    from: tx.from,
    to: tx.to ?? null,
    reverted,
    deployedContract: receipt.contractAddress ?? null,
    approvalTokenSymbol,
    approvalSpender,
  });
  if (truncated) {
    summary += ' This transaction moved more assets than shown; the list is truncated.';
  } else if (
    namedEvents.length > 0 &&
    (classification.action === 'contract_interaction' || classification.action === 'unknown')
  ) {
    summary += ` Emitted events: ${namedEvents.join(', ')}.`;
  } else if (partial) {
    summary += ' Some emitted events use formats this decoder does not recognize.';
  }

  return {
    summary,
    action_type: classification.action,
    status: reverted ? 'reverted' : 'success',
    assets_moved: movements,
    counterparties,
    risk_flags: riskFlags,
    gas_paid_usd: gasPaidUsd,
    timestamp: new Date(Number(block.timestamp) * 1000).toISOString(),
    block_number: Number(receipt.blockNumber),
    tx_hash: hash,
    basescan_url: `https://basescan.org/tx/${hash}`,
    partial,
  };
}

function round6(n: number): number {
  return Number.parseFloat(n.toFixed(6));
}

const PROTOCOL_EVENT_KINDS = new Set([
  'univ3_swap',
  'univ2_swap',
  'solidly_swap',
  'seaport_order',
  'eas_attested',
  'aave_supply',
  'aave_withdraw',
  'aave_borrow',
  'aave_repay',
  'bridge_deposit_finalized',
  'bridge_withdrawal_initiated',
  'bridge_eth_finalized',
  'bridge_eth_initiated',
  'bridge_erc20_finalized',
  'bridge_erc20_initiated',
  'name_registered',
]);

async function buildCounterparties(
  from: Address,
  to: Address | null,
  movements: ExplainResult['assets_moved'],
  events: DecodedEvent[],
): Promise<Counterparty[]> {
  const sender = from.toLowerCase();
  const seen = new Set<string>([sender, ZERO]);
  const ordered: string[] = [];
  const add = (addr: string | null | undefined) => {
    if (!addr) return;
    const lower = addr.toLowerCase();
    if (seen.has(lower)) return;
    seen.add(lower);
    ordered.push(addr);
  };

  add(to);
  // Direct counterparties of the sender's own asset movements first,
  // then protocol contracts that shaped the transaction.
  for (const m of movements) {
    if (m.from.toLowerCase() === sender) add(m.to);
    if (m.to.toLowerCase() === sender) add(m.from);
  }
  for (const e of events) {
    if (PROTOCOL_EVENT_KINDS.has(e.kind)) add(e.emitter);
  }

  const top = ordered.slice(0, MAX_COUNTERPARTIES);
  const tokenAddresses = new Set(
    movements.filter((m) => m.token_address).map((m) => (m.token_address as string).toLowerCase()),
  );

  return Promise.all(
    top.map(async (address) => {
      const known = getLabel(address);
      if (known) return { address, label: known.label };
      if (tokenAddresses.has(address.toLowerCase())) {
        const meta = await getTokenMeta(address as Address);
        if (meta && meta.symbol !== shortAddress(address)) {
          return { address, label: `${meta.symbol} token contract` };
        }
      }
      return { address, label: null };
    }),
  );
}
