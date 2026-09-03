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

/**
 * Where an ETH/USD figure came from. Returned alongside the number, always.
 *
 * ⚠️ WHY THIS EXISTS — the bug it replaces was not a wrong number, it was an
 * UNLABELLED one. The old ladder read the feed at the transaction's block, and
 * on failure silently read it at LATEST, applying today's price to a historical
 * transaction's gas with nothing in the output saying so. Public RPCs prune
 * archive state, so that fallback fires in NORMAL OPERATION, not in a rare
 * outage — and the function's own docstring called the result "deterministic
 * for a given tx", which was true of the branch above and false of the branch
 * below it.
 *
 * A degraded answer that declares itself degraded is honest and still useful.
 * A degraded answer wearing the same clothes as a good one is the failure —
 * two people re-running the same decode on different days get different gas
 * figures and neither is told why.
 *
 * This is the rule `checks{}` already follows one file over: report whether the
 * thing RAN, so absence is never mistaken for a clean result. `gas_paid_usd`
 * was the one number in the output that did not obey it.
 */
export type PriceBasis = {
  /** 'at-block' reproduces forever. 'latest' does not. 'unavailable' has no number. */
  source: 'at-block' | 'latest' | 'unavailable';
  /** The ETH/USD rate applied, or null when none could be read. */
  eth_usd: number | null;
  /** Block the feed was actually read at — present only for 'at-block'. */
  feed_block: string | null;
  /** Chainlink round the answer came from, when known. */
  round_id: string | null;
  /** Plain statement of what the number is and is not. Safe to show a buyer. */
  note: string;
};

const priceCache = new TtlCache<PriceBasis>(2_000, 24 * HOUR);

/**
 * ETH/USD for a transaction's block, WITH the provenance of the figure.
 *
 * Reads the Chainlink feed's state at that block; that answer is reproducible
 * by anyone, forever. When archive state is unavailable it falls back to the
 * latest price and SAYS SO — the fallback is kept because a labelled
 * point-in-time figure is more useful to most callers than nothing, and it is
 * removed from being a determinism claim by being labelled.
 *
 * Cached per ~10-minute block bucket, basis included, so a cached answer
 * carries the same provenance as a fresh one.
 */
export async function ethUsdAtBlock(blockNumber: bigint): Promise<PriceBasis> {
  const bucket = (blockNumber / 300n).toString();
  return priceCache.getOrLoad(`eth-usd:${bucket}`, async () => {
    try {
      const [roundId, answer] = await client.readContract({
        address: ETH_USD_FEED,
        abi: FEED_ABI,
        functionName: 'latestRoundData',
        blockNumber,
      });
      return {
        source: 'at-block',
        eth_usd: Number.parseFloat(formatUnits(answer, 8)),
        feed_block: blockNumber.toString(),
        round_id: roundId.toString(),
        note: `ETH/USD read from the Chainlink feed at block ${blockNumber}. Reproducible by anyone with archive access to that block.`,
      };
    } catch {
      try {
        const [roundId, answer] = await client.readContract({
          address: ETH_USD_FEED,
          abi: FEED_ABI,
          functionName: 'latestRoundData',
        });
        return {
          source: 'latest',
          eth_usd: Number.parseFloat(formatUnits(answer, 8)),
          feed_block: null,
          round_id: roundId.toString(),
          note:
            'LATEST price, historical state unavailable. Today\'s ETH/USD has been applied to a past transaction\'s gas, ' +
            'so this figure is NOT reproducible on another day and must not be treated as a point-in-time value.',
        };
      } catch {
        return {
          source: 'unavailable',
          eth_usd: null,
          feed_block: null,
          round_id: null,
          note: 'ETH/USD could not be read at all. gas_paid_usd is absent because the price is unknown, not because no gas was paid.',
        };
      }
    }
  });
}
