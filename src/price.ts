import { formatUnits } from 'viem';
import { HOUR, NEGATIVE_TTL, TtlCache } from './cache.js';
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
  // ⚠️ THE FEED IS READ AT A DETERMINISTIC ANCHOR, NOT AT THE CALLER'S BLOCK.
  //
  // The rate is cached per ~300-block bucket, which is fine for the NUMBER but
  // was not fine for the LABEL: whichever transaction populated a bucket left
  // its own block in `feed_block`, so a second transaction in the same bucket
  // reported a block it had not asked about, and a cold server reported a
  // different one than a warm server for the identical request. That is the
  // exact non-reproducibility this whole field exists to eliminate, reintroduced
  // by the cache — caught by decoding two real transactions ten minutes apart
  // and seeing them claim the same feed block.
  //
  // Anchoring the read to the bucket's first block makes the answer a pure
  // function of the transaction's block: same input, same rate, same
  // `feed_block`, cold or warm, first caller or thousandth.
  const anchor = (blockNumber / 300n) * 300n;
  return priceCache.getOrLoad(
    `eth-usd:${anchor.toString()}`,
    async () => {
    // ⚠️ RETRY THE HISTORICAL READ BEFORE FALLING BACK, because the fallback was
    // firing on TRANSIENT failures and mislabelling them.
    //
    // Observed: block 50842200 read `at-block` when called alone and `latest`
    // when called inside a burst — the public RPC rate-limited us, the read
    // threw, and the catch reported "historical state unavailable" for a block
    // whose archive state was perfectly available. The label was right (it was a
    // latest price) and THE STATED CAUSE WAS INVENTED. That is the same defect
    // this whole field exists to remove, one level down.
    //
    // Worse, the spurious answer was then cached for 24 hours under the anchor
    // key, so one rate-limited moment poisoned that bucket for a day and every
    // decode in it reported a non-reproducible figure.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const [roundId, answer] = await client.readContract({
          address: ETH_USD_FEED,
          abi: FEED_ABI,
          functionName: 'latestRoundData',
          blockNumber: anchor,
        });
        return {
          source: 'at-block' as const,
          eth_usd: Number.parseFloat(formatUnits(answer, 8)),
          feed_block: anchor.toString(),
          round_id: roundId.toString(),
          note: `ETH/USD read from the Chainlink feed at block ${anchor}, the ~10-minute anchor for this transaction's block. Reproducible by anyone with archive access to that block.`,
        };
      } catch (err) {
        lastErr = err;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }
    void lastErr;
    try {
      const [roundId, answer] = await client.readContract({
        address: ETH_USD_FEED,
        abi: FEED_ABI,
        functionName: 'latestRoundData',
        blockNumber: anchor,
      });
      return {
        source: 'at-block',
        eth_usd: Number.parseFloat(formatUnits(answer, 8)),
        feed_block: anchor.toString(),
        round_id: roundId.toString(),
        note: `ETH/USD read from the Chainlink feed at block ${anchor}, the ~10-minute anchor for this transaction's block. Reproducible by anyone with archive access to that block.`,
      };
    } catch {
      // ⚠️ ESTABLISH THE CAUSE RATHER THAN SHRUGGING AT IT. One extra read, only on
      // a path that is already rare, and it separates two cases a buyer would
      // treat completely differently:
      //
      //   the feed had NO CODE at that block — deterministic and reproducible
      //     forever, because a contract that did not exist then never will have.
      //     Observed: the ETH/USD feed has no code at Base block 2,000,000.
      //   the feed existed and we still could not read it — genuinely unknown,
      //     and the honest answer stays "not established".
      //
      // Without this the note blamed pruned archive state for what was sometimes
      // a rate limit and sometimes a contract that had not been deployed yet.
      let feedExisted: boolean | null = null;
      try {
        const code = await client.getCode({ address: ETH_USD_FEED, blockNumber: anchor });
        feedExisted = Boolean(code && code !== '0x');
      } catch {
        feedExisted = null;
      }
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
            'LATEST price applied to a past transaction\'s gas, so this figure is NOT reproducible on another day ' +
            'and must not be treated as a point-in-time value. ' +
            (feedExisted === false
              ? `The Chainlink ETH/USD feed had no code at block ${anchor} — it was not deployed yet, so no ` +
                'at-block price exists for this transaction and none ever will. That part IS reproducible.'
              : feedExisted === true
                ? 'The feed existed at that block but could not be read after retries; the cause is not established ' +
                  'here and may be pruned archive state or a transient upstream failure.'
                : 'Whether the feed existed at that block could not be determined, so the cause is not established.'),
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
    },
    // ⚠️ ONLY AN `at-block` ANSWER IS DURABLE. It is a fact about an already-mined
    // block and cannot change. `latest` and `unavailable` are statements about a
    // moment of upstream health, and caching them for a day is how a transient
    // blip becomes a day of non-reproducible figures — the same reason
    // verification.ts gives `unknown` a short TTL and firstTime.ts gives
    // `unreachable` one. price.ts is the file that missed that convention twice.
    (v) => (v.source === 'at-block' ? 24 * HOUR : NEGATIVE_TTL),
  );
}
