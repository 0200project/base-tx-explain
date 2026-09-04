import { formatEther, formatUnits, type Address } from 'viem';
import type { AssetMovement } from '../types.js';
import type { DecodedEvent } from './events.js';
import { getContractName, getTokenMeta, shortAddress } from './tokens.js';

const MAX_MOVEMENTS = 60;

interface TxContext {
  from: Address;
  to: Address | null;
  value: bigint;
  wethAddress: Address;
  /** A reverted transaction moved nothing, whatever value it carried. */
  reverted: boolean;
}

/**
 * Translate decoded logs + native value into the assets_moved list.
 * Zero-value ERC-20 transfers (airdrop spam) are dropped. Output is capped;
 * `truncated` tells the caller to mark the result partial.
 *
 * A REVERTED transaction moves nothing. Its logs are discarded by the EVM, so
 * `events` is empty — but `tx.value` still holds whatever the sender attached,
 * and the EVM refunded it. Reporting that as a movement asserted a transfer that
 * provably did not happen, and contradicted `status`, the `transaction_reverted`
 * flag, and the summary's own "no assets moved" in the same response.
 */
export async function buildAssetsMoved(
  events: DecodedEvent[],
  tx: TxContext,
): Promise<{ movements: AssetMovement[]; truncated: boolean; flaggedSymbols: Array<{ address: string; status: 'nonstandard' | 'impersonation' }> }> {
  const movements: AssetMovement[] = [];
  // One flag rather than a `truncated: true` early return, because the cap can
  // also be reached INSIDE a single event (an ERC-1155 batch), where there is no
  // next iteration to notice it.
  let truncated = false;

  // Not `tx.value > 0n` alone: on a reverted transaction the value was returned
  // to the sender, so there is nothing to report.
  if (!tx.reverted && tx.value > 0n && tx.to) {
    movements.push({
      token: 'ETH',
      amount: formatEther(tx.value),
      from: tx.from,
      to: tx.to,
      token_address: null,
      standard: 'native',
    });
  }

  const erc20Addresses = new Set<Address>();
  const nftAddresses = new Set<Address>();
  for (const e of events) {
    if (e.kind === 'erc20_transfer') erc20Addresses.add(e.emitter);
    if (e.kind === 'erc721_transfer' || e.kind === 'erc1155_single' || e.kind === 'erc1155_batch') {
      nftAddresses.add(e.emitter);
    }
  }

  const [erc20Metas, nftNames] = await Promise.all([
    Promise.all(
      [...erc20Addresses].map(async (a) => [a, await getTokenMeta(a)] as const),
    ),
    Promise.all([...nftAddresses].map(async (a) => [a, await getContractName(a)] as const)),
  ]);
  const metaByAddress = new Map(erc20Metas);
  const nameByAddress = new Map(nftNames);

  // Tokens whose self-reported symbol could not be trusted as an identity (shown
  // as their address instead). Surfaced as risk flags by the caller, split by
  // reason: a non-standard symbol vs. an impersonation of a known token.
  const flaggedSymbols = [...metaByAddress.entries()]
    .filter(([, m]) => m && m.symbolStatus && m.symbolStatus !== 'ok')
    .map(([a, m]) => ({ address: a as string, status: (m as { symbolStatus: 'nonstandard' | 'impersonation' }).symbolStatus }));

  const wethLower = tx.wethAddress.toLowerCase();

  for (const e of events) {
    if (movements.length >= MAX_MOVEMENTS) {
      truncated = true;
      break;
    }
    const a = e.args;
    switch (e.kind) {
      case 'erc20_transfer': {
        const value = a.value as bigint;
        if (value === 0n) break;
        const meta = metaByAddress.get(e.emitter);
        movements.push({
          token: meta?.symbol ?? shortAddress(e.emitter),
          amount: formatUnits(value, meta?.decimals ?? 18),
          from: a.from as string,
          to: a.to as string,
          token_address: e.emitter,
          standard: 'erc20',
        });
        break;
      }
      case 'erc721_transfer': {
        movements.push({
          token: nameByAddress.get(e.emitter) ?? shortAddress(e.emitter),
          amount: '1',
          from: a.from as string,
          to: a.to as string,
          token_address: e.emitter,
          token_id: (a.tokenId as bigint).toString(),
          standard: 'erc721',
        });
        break;
      }
      case 'erc1155_single': {
        movements.push({
          token: nameByAddress.get(e.emitter) ?? shortAddress(e.emitter),
          amount: (a.value as bigint).toString(),
          from: a.from as string,
          to: a.to as string,
          token_address: e.emitter,
          token_id: (a.id as bigint).toString(),
          standard: 'erc1155',
        });
        break;
      }
      case 'erc1155_batch': {
        const ids = a.ids as bigint[];
        const values = a.values as bigint[];
        // `i` is declared outside the loop so we can tell "consumed every id"
        // from "stopped at the cap". Without that distinction a batch that
        // overflowed reported truncated:false and the response claimed to list
        // every asset that moved while silently dropping the rest.
        let i = 0;
        for (; i < ids.length && movements.length < MAX_MOVEMENTS; i++) {
          movements.push({
            token: nameByAddress.get(e.emitter) ?? shortAddress(e.emitter),
            amount: (values[i] ?? 0n).toString(),
            from: a.from as string,
            to: a.to as string,
            token_address: e.emitter,
            token_id: (ids[i] ?? 0n).toString(),
            standard: 'erc1155',
          });
        }
        if (i < ids.length) truncated = true; // ids remained when the cap hit
        break;
      }
      case 'weth_deposit': {
        if (e.emitter.toLowerCase() !== wethLower) break;
        movements.push({
          token: 'WETH',
          amount: formatEther(a.wad as bigint),
          from: e.emitter,
          to: a.dst as string,
          token_address: e.emitter,
          standard: 'erc20',
        });
        break;
      }
      case 'weth_withdrawal': {
        if (e.emitter.toLowerCase() !== wethLower) break;
        movements.push({
          token: 'WETH',
          amount: formatEther(a.wad as bigint),
          from: a.src as string,
          to: e.emitter,
          token_address: e.emitter,
          standard: 'erc20',
        });
        movements.push({
          token: 'ETH',
          amount: formatEther(a.wad as bigint),
          from: e.emitter,
          to: a.src as string,
          token_address: null,
          standard: 'native',
        });
        break;
      }
      default:
        break;
    }
  }

  return { movements, truncated, flaggedSymbols };
}

/**
 * Net flow of each asset relative to one address (usually the tx sender):
 * positive = received, negative = sent. Drives "swapped X for Y" phrasing.
 */
/**
 * Whether the subject parted with or gained a NON-FUNGIBLE.
 *
 * `netFlows` skips erc721/erc1155 deliberately — a token id has no meaningful
 * "net", and summing ids would be nonsense. But callers that ask netFlows a
 * DIRECTIONAL question ("did they part with value and get nothing back?") were
 * silently getting `false` for NFT-only transactions, because no flow entry
 * exists to be negative. That is the answer to a different question than the
 * one asked, and classify.ts:188 — the guard that stops a drainer's `claim()`
 * being summarised as a reward — was reading it as "no outflow".
 *
 * Reported as two booleans rather than a quantity, because direction is the
 * only thing anyone can honestly ask of a set of token ids.
 */
export function nftFlow(movements: AssetMovement[], subject: string): { sent: boolean; received: boolean } {
  const who = subject.toLowerCase();
  let sent = false;
  let received = false;
  for (const m of movements) {
    if (m.standard !== 'erc721' && m.standard !== 'erc1155') continue;
    if (m.from.toLowerCase() === who) sent = true;
    if (m.to.toLowerCase() === who) received = true;
  }
  return { sent, received };
}

export function netFlows(movements: AssetMovement[], subject: string): Map<string, { token: string; net: number }> {
  const flows = new Map<string, { token: string; net: number }>();
  const who = subject.toLowerCase();
  for (const m of movements) {
    if (m.standard === 'erc721' || m.standard === 'erc1155') continue;
    const key = m.token_address ? m.token_address.toLowerCase() : 'native';
    const amount = Number.parseFloat(m.amount);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const entry = flows.get(key) ?? { token: m.token, net: 0 };
    if (m.from.toLowerCase() === who) entry.net -= amount;
    if (m.to.toLowerCase() === who) entry.net += amount;
    flows.set(key, entry);
  }
  return flows;
}
