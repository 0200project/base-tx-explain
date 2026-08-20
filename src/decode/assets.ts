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
}

/**
 * Translate decoded logs + native value into the assets_moved list.
 * Zero-value ERC-20 transfers (airdrop spam) are dropped. Output is capped;
 * `truncated` tells the caller to mark the result partial.
 */
export async function buildAssetsMoved(
  events: DecodedEvent[],
  tx: TxContext,
): Promise<{ movements: AssetMovement[]; truncated: boolean }> {
  const movements: AssetMovement[] = [];

  if (tx.value > 0n && tx.to) {
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

  const wethLower = tx.wethAddress.toLowerCase();

  for (const e of events) {
    if (movements.length >= MAX_MOVEMENTS) {
      return { movements, truncated: true };
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
        for (let i = 0; i < ids.length && movements.length < MAX_MOVEMENTS; i++) {
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

  return { movements, truncated: false };
}

/**
 * Net flow of each asset relative to one address (usually the tx sender):
 * positive = received, negative = sent. Drives "swapped X for Y" phrasing.
 */
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
