import { toFunctionSelector, type Hex } from 'viem';
import { DAY, TtlCache } from '../cache.js';
import { sanitizeSymbol } from './tokens.js';

/** Coarse intent hint derived from the called function, used as a tiebreaker by the classifier. */
export type SelectorHint =
  | 'transfer'
  | 'approve'
  | 'set_approval_for_all'
  | 'swap'
  | 'wrap'
  | 'unwrap'
  | 'mint'
  | 'claim'
  | 'stake'
  | 'unstake'
  | 'bridge'
  | 'register'
  | 'attest'
  | 'handle_ops'
  | 'multicall'
  | 'batch_transfer'
  | 'nft_trade'
  | 'lending'
  | 'permit';

interface BuiltinSelector {
  name: string;
  hint: SelectorHint | null;
}

const BUILTIN_SIGNATURES: Array<[string, SelectorHint | null]> = [
  ['transfer(address,uint256)', 'transfer'],
  ['transferFrom(address,address,uint256)', 'transfer'],
  ['safeTransferFrom(address,address,uint256)', 'transfer'],
  ['safeTransferFrom(address,address,uint256,bytes)', 'transfer'],
  ['safeTransferFrom(address,address,uint256,uint256,bytes)', 'transfer'],
  ['safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)', 'batch_transfer'],
  ['approve(address,uint256)', 'approve'],
  ['setApprovalForAll(address,bool)', 'set_approval_for_all'],
  ['permit(address,address,uint256,uint256,uint8,bytes32,bytes32)', 'permit'],
  ['permit(address,((address,uint160,uint48,uint48),address,uint256),bytes)', 'permit'],
  // WETH
  ['deposit()', 'wrap'],
  ['withdraw(uint256)', 'unwrap'],
  // Uniswap Universal Router / routers
  ['execute(bytes,bytes[],uint256)', 'swap'],
  ['execute(bytes,bytes[])', 'swap'],
  ['exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))', 'swap'],
  ['exactInput((bytes,address,uint256,uint256,uint256))', 'swap'],
  ['exactOutputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))', 'swap'],
  ['swapExactTokensForTokens(uint256,uint256,address[],address,uint256)', 'swap'],
  ['swapExactETHForTokens(uint256,address[],address,uint256)', 'swap'],
  ['swapExactTokensForETH(uint256,uint256,address[],address,uint256)', 'swap'],
  ['swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)', 'swap'],
  ['swapExactTokensForTokens(uint256,uint256,(address,address,bool)[],address,uint256)', 'swap'], // Solidly-style route
  ['swap(address,bool,int256,uint160,bytes)', 'swap'],
  ['multicall(bytes[])', 'multicall'],
  ['multicall(uint256,bytes[])', 'multicall'],
  ['aggregate3((address,bool,bytes)[])', 'multicall'],
  // 4337
  ['handleOps((address,uint256,bytes,bytes,uint256,uint256,uint256,uint256,uint256,bytes,bytes)[],address)', 'handle_ops'],
  ['handleOps((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)[],address)', 'handle_ops'],
  // Mint-ish
  ['mint(address)', 'mint'],
  ['mint(address,uint256)', 'mint'],
  ['mint(uint256)', 'mint'],
  ['mintWithComment(address,uint256,string)', 'mint'],
  ['purchase(uint256)', 'mint'],
  // Claims
  ['claim()', 'claim'],
  ['claim(address)', 'claim'],
  ['claim(uint256)', 'claim'],
  ['claimRewards()', 'claim'],
  ['claimRewards(address)', 'claim'],
  ['claimRewards(address[],address)', 'claim'],
  ['getReward()', 'claim'],
  ['getReward(address)', 'claim'],
  ['getReward(address,address[])', 'claim'],
  ['claim(uint256,address,uint256,bytes32[])', 'claim'],
  // Staking
  ['stake(uint256)', 'stake'],
  ['stake(uint256,address)', 'stake'],
  ['unstake(uint256)', 'unstake'],
  ['withdraw(uint256,address,address)', 'lending'],
  // Lending (Aave/Compound style)
  ['supply(address,uint256,address,uint16)', 'lending'],
  ['borrow(address,uint256,uint256,uint16,address)', 'lending'],
  ['repay(address,uint256,uint256,address)', 'lending'],
  ['supply(address,uint256)', 'lending'],
  ['withdraw(address,uint256)', 'lending'],
  // Bridges
  ['depositTransaction(address,uint256,uint64,bool,bytes)', 'bridge'],
  ['bridgeETHTo(address,uint32,bytes)', 'bridge'],
  ['bridgeERC20To(address,address,address,uint256,uint32,bytes)', 'bridge'],
  ['withdrawTo(address,address,uint256,uint32,bytes)', 'bridge'],
  ['depositV3(address,address,address,address,uint256,uint256,uint256,address,uint32,uint32,bytes)', 'bridge'],
  // Names
  ['register((string,address,uint256,address,bytes[],bool))', 'register'],
  ['registerWithSignature((string,address,uint256,address,bytes[],bool),uint256,bytes)', 'register'],
  // EAS
  ['attest((bytes32,(address,uint64,bool,bytes32,bytes,uint256)))', 'attest'],
  // Seaport
  ['fulfillBasicOrder((address,uint256,uint256,address,address,address,uint256,uint256,uint8,uint256,uint256,bytes32,uint256,bytes32,bytes32,uint256,(uint256,address)[],bytes))', 'nft_trade'],
  ['fulfillBasicOrder_efficient_6GL6yc((address,uint256,uint256,address,address,address,uint256,uint256,uint8,uint256,uint256,bytes32,uint256,bytes32,bytes32,uint256,(uint256,address)[],bytes))', 'nft_trade'],
  // Disperse-style
  ['disperseEther(address[],uint256[])', 'batch_transfer'],
  ['disperseToken(address,address[],uint256[])', 'batch_transfer'],
];

const BUILTIN = new Map<Hex, BuiltinSelector>();
for (const [sig, hint] of BUILTIN_SIGNATURES) {
  try {
    BUILTIN.set(toFunctionSelector(`function ${sig}`), { name: sig.slice(0, sig.indexOf('(')), hint });
  } catch {
    // A malformed signature in the table should never take the server down.
  }
}

const lookupCache = new TtlCache<BuiltinSelector | null>(5_000, 30 * DAY);

/**
 * Resolve a 4-byte selector to a function name + intent hint.
 * Builtin table first (no network), then the Sourcify signature database
 * (the continuation of openchain.xyz / 4byte.directory, merged datasets),
 * cached for 30 days. Never throws.
 */
export async function lookupSelector(selector: Hex): Promise<BuiltinSelector | null> {
  const builtin = BUILTIN.get(selector);
  if (builtin) return builtin;

  return lookupCache.getOrLoad(selector, async () => {
    try {
      const res = await fetch(
        `https://api.4byte.sourcify.dev/signature-database/v1/lookup?function=${selector}&filter=true`,
        { signal: AbortSignal.timeout(4_000) },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as {
        result?: { function?: Record<string, Array<{ name: string }> | null> };
      };
      const entries = body.result?.function?.[selector];
      const name = entries?.[0]?.name;
      if (!name) return null;
      // The signature is community-submitted (anyone can register a selector's
      // "name") and flows into the summary as "(function: X)". Sanitize it the
      // same way as token symbols before it becomes attacker-controlled prose;
      // hint inference still reads the raw signature (never shown to the user).
      const fnName = sanitizeSymbol(name.slice(0, name.indexOf('(')));
      if (!fnName) return null;
      return { name: fnName, hint: inferHint(name) };
    } catch {
      return null;
    }
  });
}

function inferHint(signature: string): SelectorHint | null {
  const fn = signature.toLowerCase();
  if (fn.includes('swap')) return 'swap';
  if (fn.startsWith('claim') || fn.includes('getreward')) return 'claim';
  if (fn.startsWith('mint') || fn.includes('purchase')) return 'mint';
  if (fn.startsWith('stake') || fn.startsWith('deposit')) return 'stake';
  if (fn.startsWith('unstake')) return 'unstake';
  if (fn.includes('bridge')) return 'bridge';
  if (fn.startsWith('register')) return 'register';
  if (fn.startsWith('multicall')) return 'multicall';
  return null;
}
