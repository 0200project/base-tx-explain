import { formatUnits } from 'viem';
import { HOUR, TtlCache } from './cache.js';
import { client } from './rpc.js';

// Chainlink ETH/USD aggregator proxy on Base mainnet (docs.chain.link).
const ETH_USD_FEED = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70' as const;

const FEED_ABI = [
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
] as const;

const priceCache = new TtlCache<number | null>(2_000, 24 * HOUR);

/**
 * ETH/USD at (or near) a block, read from the Chainlink feed's state at that
 * block — deterministic for a given tx. Public RPCs prune old state, so the
 * fallback ladder is: price at block → latest price → null. Cached per
 * ~10-minute block bucket.
 */
export async function ethUsdAtBlock(blockNumber: bigint): Promise<number | null> {
  const bucket = (blockNumber / 300n).toString();
  return priceCache.getOrLoad(`eth-usd:${bucket}`, async () => {
    try {
      const [, answer] = await client.readContract({
        address: ETH_USD_FEED,
        abi: FEED_ABI,
        functionName: 'latestRoundData',
        blockNumber,
      });
      return Number.parseFloat(formatUnits(answer, 8));
    } catch {
      try {
        const [, answer] = await client.readContract({
          address: ETH_USD_FEED,
          abi: FEED_ABI,
          functionName: 'latestRoundData',
        });
        return Number.parseFloat(formatUnits(answer, 8));
      } catch {
        return null;
      }
    }
  });
}
