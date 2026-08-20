import type { Address } from 'viem';
import { netFlows } from './decode/assets.js';
import type { Classification } from './decode/classify.js';
import { shortAddress } from './decode/tokens.js';
import { getLabel } from './labels.js';
import type { AssetMovement } from './types.js';

interface SummaryContext {
  classification: Classification;
  movements: AssetMovement[];
  from: Address;
  to: Address | null;
  reverted: boolean;
  deployedContract: string | null;
  /** Symbol of the token contract being approved, when the action is an approval. */
  approvalTokenSymbol?: string | null;
}

/** Compact human number: thousands separators, at most 6 significant decimals. */
export function fmtAmount(raw: string): string {
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return raw;
  if (n !== 0 && Math.abs(n) < 0.000001) return raw; // keep tiny dust exact
  const decimals = Math.abs(n) >= 1 ? Math.min(6, Math.max(0, 6 - String(Math.trunc(Math.abs(n))).length)) : 6;
  return n.toLocaleString('en-US', { maximumFractionDigits: decimals });
}

function nameOf(address: string | null | undefined): string {
  if (!address) return 'unknown';
  return getLabel(address)?.label ?? shortAddress(address);
}

function flowsFor(movements: AssetMovement[], subject: string) {
  const flows = [...netFlows(movements, subject).values()];
  const sent = flows.filter((f) => f.net < -1e-12).sort((a, b) => a.net - b.net);
  const received = flows.filter((f) => f.net > 1e-12).sort((a, b) => b.net - a.net);
  return { sent, received };
}

const list = (items: string[]): string =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/**
 * The 1–3 sentence plain-English summary. Deterministic templates only — no
 * model anywhere near this path. Reverted transactions describe the attempt.
 */
export function buildSummary(ctx: SummaryContext): string {
  const { classification, movements, from, to, reverted, deployedContract } = ctx;
  const { action, detail } = classification;
  const sender = shortAddress(from);
  const via = detail.protocol ? ` via ${detail.protocol}` : to && getLabel(to) ? ` via ${nameOf(to)}` : '';
  const { sent, received } = flowsFor(movements, from);
  const sentStr = list(sent.map((f) => `${fmtAmount(String(-f.net))} ${f.token}`));
  const receivedStr = list(received.map((f) => `${fmtAmount(String(f.net))} ${f.token}`));

  const attempted = (text: string): string =>
    reverted ? `${sender} attempted to ${text}, but the transaction reverted and no assets moved.` : '';

  switch (action) {
    case 'eth_transfer': {
      if (reverted) return attempted(`send ETH to ${nameOf(to)}`);
      const m = movements.find((x) => x.standard === 'native');
      const self = to && to.toLowerCase() === from.toLowerCase();
      if (!m) {
        return self
          ? `${sender} sent an empty transaction to themselves — typically a nonce-management or cancellation transaction. No assets moved.`
          : `${sender} sent an empty transaction to ${nameOf(to)}. No assets moved.`;
      }
      return `${sender} sent ${fmtAmount(m.amount)} ETH to ${self ? 'themselves' : nameOf(to)}.`;
    }
    case 'erc20_transfer': {
      if (reverted) return attempted(`transfer tokens to ${nameOf(to)}`);
      const outs = movements.filter((m) => m.standard === 'erc20' && m.from.toLowerCase() === from.toLowerCase());
      const m = outs[0] ?? movements[0];
      if (!m) return `${sender} transferred tokens.`;
      return `${sender} sent ${fmtAmount(m.amount)} ${m.token} to ${nameOf(m.to)}.`;
    }
    case 'erc20_approval': {
      const tokenName = ctx.approvalTokenSymbol ?? nameOf(to);
      if (reverted) return attempted(`grant a token approval on ${tokenName}`);
      return `${sender} approved a spender to use their ${tokenName} tokens. No assets moved in this transaction.`;
    }
    case 'approval_revoked':
      if (reverted) return attempted('revoke an approval');
      return `${sender} revoked a previously granted approval on ${nameOf(to)}. No assets moved.`;
    case 'approval_for_all':
      if (reverted) return attempted(`grant operator approval on ${nameOf(to)}`);
      return `${sender} granted an operator approval for ALL tokens in collection ${nameOf(to)} — the operator can move any of these tokens from now on. No assets moved yet.`;
    case 'swap': {
      if (reverted) return attempted(`swap tokens${via}`);
      if (sentStr && receivedStr) return `${sender} swapped ${sentStr} for ${receivedStr}${via}.`;
      // Bot/contract-executed swaps: assets flow through the called contract,
      // not the EOA sender — describe the contract's net flows instead.
      if (to) {
        const contractFlows = flowsFor(movements, to);
        const cSent = list(contractFlows.sent.map((f) => `${fmtAmount(String(-f.net))} ${f.token}`));
        const cReceived = list(contractFlows.received.map((f) => `${fmtAmount(String(f.net))} ${f.token}`));
        if (cSent && cReceived) {
          return `${sender} triggered contract ${nameOf(to)} to swap ${cSent} for ${cReceived}${via}.`;
        }
      }
      // Last resort: aggregate flows across the whole transaction.
      const totals = new Map<string, number>();
      for (const m of movements) {
        if (m.standard !== 'erc20' && m.standard !== 'native') continue;
        const v = Number.parseFloat(m.amount);
        if (Number.isFinite(v)) totals.set(m.token, (totals.get(m.token) ?? 0) + v);
      }
      const legs = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
      if (legs.length === 2) {
        return `A swap between ${fmtAmount(String(legs[0]?.[1]))} ${legs[0]?.[0]} and ${fmtAmount(String(legs[1]?.[1]))} ${legs[1]?.[0]} was executed${via}, initiated by ${sender}.`;
      }
      return `${sender} executed a token swap${via}.`;
    }
    case 'add_liquidity': {
      if (reverted) return attempted(`add liquidity${via}`);
      return sentStr
        ? `${sender} added liquidity of ${sentStr} to a pool${via}.`
        : `${sender} added liquidity to a pool${via}.`;
    }
    case 'remove_liquidity': {
      if (reverted) return attempted(`remove liquidity${via}`);
      return receivedStr
        ? `${sender} removed liquidity from a pool${via}, receiving ${receivedStr}.`
        : `${sender} removed liquidity from a pool${via}.`;
    }
    case 'wrap': {
      if (reverted) return attempted('wrap ETH into WETH');
      const m = movements.find((x) => x.token === 'WETH');
      return `${sender} wrapped ${m ? `${fmtAmount(m.amount)} ETH` : 'ETH'} into WETH.`;
    }
    case 'unwrap': {
      if (reverted) return attempted('unwrap WETH back to ETH');
      const m = movements.find((x) => x.token === 'WETH');
      return `${sender} unwrapped ${m ? `${fmtAmount(m.amount)} WETH` : 'WETH'} back to ETH.`;
    }
    case 'nft_mint': {
      if (reverted) return attempted(`mint from ${nameOf(to)}`);
      const count = detail.mintCount ?? 1;
      const cost = sentStr ? ` for ${sentStr}` : '';
      const collection = detail.collection ?? nameOf(to);
      return `${sender} minted ${count === 1 ? 'an NFT' : `${count} NFTs`} from ${collection}${cost}.`;
    }
    case 'nft_transfer': {
      if (reverted) return attempted('transfer an NFT');
      const m = movements.find((x) => x.standard === 'erc721' || x.standard === 'erc1155');
      if (!m) return `${sender} transferred an NFT.`;
      return `${sender} transferred ${m.token}${m.token_id ? ` #${m.token_id}` : ''} to ${nameOf(m.to)}.`;
    }
    case 'nft_sale': {
      if (reverted) return attempted(`trade an NFT${via}`);
      const bought = movements.find(
        (m) => (m.standard === 'erc721' || m.standard === 'erc1155') && m.to.toLowerCase() === from.toLowerCase(),
      );
      const sold = movements.find(
        (m) => (m.standard === 'erc721' || m.standard === 'erc1155') && m.from.toLowerCase() === from.toLowerCase(),
      );
      if (bought) {
        const price = sentStr ? ` for ${sentStr}` : '';
        return `${sender} bought ${bought.token}${bought.token_id ? ` #${bought.token_id}` : ''}${price}${via}.`;
      }
      if (sold) {
        const proceeds = receivedStr ? ` for ${receivedStr}` : '';
        return `${sender} sold ${sold.token}${sold.token_id ? ` #${sold.token_id}` : ''}${proceeds}${via}.`;
      }
      const anyNft = movements.find((m) => m.standard === 'erc721' || m.standard === 'erc1155');
      if (anyNft) {
        return `${anyNft.token}${anyNft.token_id ? ` #${anyNft.token_id}` : ''} was sold by ${nameOf(anyNft.from)} to ${nameOf(anyNft.to)}${via}; ${sender} submitted the transaction.`;
      }
      return `An NFT trade settled${via}; ${sender} was a party to it.`;
    }
    case 'token_mint': {
      if (reverted) return attempted('mint tokens');
      return receivedStr
        ? `${sender} received ${receivedStr}, newly minted${via}.`
        : `${sender} minted tokens${via}.`;
    }
    case 'bridge_out': {
      if (reverted) return attempted(`bridge assets out of Base${via}`);
      if (!sentStr && movements.length === 0) {
        return `${sender} sent a cross-chain message out of Base${via}. No assets moved on Base in this transaction.`;
      }
      return `${sender} bridged ${sentStr || 'assets'} out of Base${via}. The funds arrive on the destination chain separately.`;
    }
    case 'bridge_in': {
      if (reverted) return attempted('receive bridged assets');
      if (!receivedStr && movements.length === 0) {
        return `A cross-chain message was relayed into Base${via}, initiated for ${sender}. No assets moved on Base in this transaction.`;
      }
      return `${sender} received ${receivedStr || 'assets'} bridged into Base${via}.`;
    }
    case 'lending_supply':
      if (reverted) return attempted(`supply assets to ${nameOf(to)}`);
      return `${sender} supplied ${sentStr || 'assets'} to ${detail.protocol ?? nameOf(to)} as lending collateral or deposit.`;
    case 'lending_withdraw':
      if (reverted) return attempted(`withdraw from ${nameOf(to)}`);
      return `${sender} withdrew ${receivedStr || 'assets'} from ${detail.protocol ?? nameOf(to)}.`;
    case 'lending_borrow':
      if (reverted) return attempted(`borrow from ${nameOf(to)}`);
      return `${sender} borrowed ${receivedStr || 'assets'} from ${detail.protocol ?? nameOf(to)}.`;
    case 'lending_repay':
      if (reverted) return attempted(`repay a loan on ${nameOf(to)}`);
      return `${sender} repaid ${sentStr || 'a loan'} on ${detail.protocol ?? nameOf(to)}.`;
    case 'stake':
      if (reverted) return attempted(`stake${via}`);
      return `${sender} staked ${sentStr || 'assets'}${via}.`;
    case 'unstake':
      if (reverted) return attempted(`unstake${via}`);
      return `${sender} unstaked ${receivedStr || 'assets'}${via}.`;
    case 'claim':
      if (reverted) return attempted(`claim rewards${via}`);
      return `${sender} claimed ${receivedStr || 'rewards'}${via}.`;
    case 'batch_transfer': {
      if (reverted) return attempted('send a batch of transfers');
      const recipients = new Set(
        movements.filter((m) => m.from.toLowerCase() === from.toLowerCase()).map((m) => m.to.toLowerCase()),
      ).size;
      return `${sender} sent ${sentStr || 'assets'} to ${recipients} recipients in one batch transaction.`;
    }
    case 'account_abstraction_bundle': {
      const n = detail.userOpCount ?? 0;
      return `ERC-4337 bundler transaction: ${sender} submitted ${n === 1 ? 'one smart-account operation' : `${n || 'multiple'} smart-account operations`} through the EntryPoint contract. Asset movements listed here belong to those inner operations, not the bundler.`;
    }
    case 'attestation':
      if (reverted) return attempted('create an onchain attestation');
      return `${sender} created an onchain attestation via the Ethereum Attestation Service. No assets moved.`;
    case 'name_registration': {
      if (reverted) return attempted('register an onchain name');
      const name = detail.registeredName ? `"${detail.registeredName}"` : 'an onchain name';
      return `${sender} registered ${name}${via}${sentStr ? ` for ${sentStr}` : ''}.`;
    }
    case 'contract_deployment':
      return `${sender} deployed a new contract${deployedContract ? ` at ${shortAddress(deployedContract)}` : ''}.`;
    case 'contract_interaction': {
      const fn = detail.fnName
        ? ` (function: ${detail.fnName})`
        : detail.selector
          ? ` (unrecognized function, selector ${detail.selector})`
          : '';
      if (reverted) return `${sender} called ${nameOf(to)}${fn}, but the transaction reverted and no assets moved.`;
      const moved =
        sentStr && receivedStr
          ? ` Net effect for the sender: sent ${sentStr}, received ${receivedStr}.`
          : sentStr
            ? ` The sender paid ${sentStr}.`
            : receivedStr
              ? ` The sender received ${receivedStr}.`
              : movements.length === 0
                ? ' No assets moved.'
                : '';
      return `${sender} called contract ${nameOf(to)}${fn}.${moved}`;
    }
    case 'unknown':
    default:
      if (reverted) return `${sender} sent a transaction to ${nameOf(to)} that reverted; its purpose could not be decoded.`;
      return `${sender} sent a transaction to ${nameOf(to)}; its purpose could not be fully decoded from onchain data.`;
  }
}
