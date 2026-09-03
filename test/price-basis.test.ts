import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * The defect this guards against was not a wrong number — it was an UNLABELLED
 * one. `ethUsdAtBlock` read the Chainlink feed at the transaction's block and,
 * on failure, silently read it at LATEST, applying today's price to a past
 * transaction's gas with nothing in the output saying so. Public RPCs prune
 * archive state, so that path fires in normal operation.
 *
 * The cost was commercial rather than cosmetic: two people re-running the same
 * decode on different days get different `gas_paid_usd` figures, and under an
 * acceptance clause defined as "reproducible by the buyer", the one who reports
 * it as non-reproducing is CORRECT.
 *
 * So these tests assert the LABEL, not the arithmetic.
 */

let mode: 'ok' | 'no-archive' | 'dead' = 'ok';

vi.mock('../src/rpc.js', () => ({
  client: {
    readContract: async (args: { blockNumber?: bigint }) => {
      if (args.blockNumber !== undefined) {
        if (mode !== 'ok') throw new Error('missing trie node (state pruned)');
        return [11n, 300000000000n, 0n, 0n, 11n];
      }
      if (mode === 'dead') throw new Error('rpc down');
      return [99n, 450000000000n, 0n, 0n, 99n];
    },
  },
}));

const { ethUsdAtBlock } = await import('../src/price.js');

let block = 1000n;
beforeEach(() => {
  block += 100_000n; // dodge the module-level bucket cache between cases
});

describe('gas price provenance travels with the figure', () => {
  it('labels a historical read as at-block, and names the block it used', async () => {
    mode = 'ok';
    const b = await ethUsdAtBlock(block);
    expect(b.source).toBe('at-block');
    expect(b.eth_usd).toBe(3000);
    // The anchor, not the caller's block — see the anchoring test below.
    expect(b.feed_block).toBe(((block / 300n) * 300n).toString());
    expect(b.note).toMatch(/reproducible/i);
  });

  it('DECLARES the fallback rather than passing today’s price off as historical', async () => {
    mode = 'no-archive';
    const b = await ethUsdAtBlock(block);
    expect(b.source).toBe('latest');
    expect(b.eth_usd).toBe(4500);
    // The number is still served — a labelled point-in-time figure is useful.
    // What must never happen is it arriving dressed as an at-block read.
    expect(b.feed_block).toBeNull();
    expect(b.note).toMatch(/NOT reproducible/i);
  });

  it('gives the SAME feed_block to two transactions in one bucket, cold or warm', async () => {
    // The cache is keyed per ~300-block bucket. Before anchoring, whichever
    // transaction populated a bucket left ITS block in feed_block, so a second
    // transaction in the same bucket reported a block it never asked about and
    // a cold server disagreed with a warm one about the identical request.
    // Caught in production by decoding two real transactions ten minutes apart
    // and seeing both claim the same feed block.
    mode = 'ok';
    const base = 60_000_000n;
    const a = await ethUsdAtBlock(base + 10n);
    const b = await ethUsdAtBlock(base + 290n); // same bucket, different block
    expect(a.feed_block).toBe(b.feed_block);
    expect(a.feed_block).toBe(((base + 10n) / 300n * 300n).toString());
    expect(a.eth_usd).toBe(b.eth_usd);
  });

  it('distinguishes "price unknown" from "no gas paid"', async () => {
    mode = 'dead';
    const b = await ethUsdAtBlock(block);
    expect(b.source).toBe('unavailable');
    expect(b.eth_usd).toBeNull();
    expect(b.note).toMatch(/not because no gas was paid/i);
  });

  it('never returns a number without a source', async () => {
    for (const m of ['ok', 'no-archive', 'dead'] as const) {
      mode = m;
      block += 100_000n;
      const b = await ethUsdAtBlock(block);
      expect(['at-block', 'latest', 'unavailable']).toContain(b.source);
      if (b.eth_usd !== null) expect(b.source).not.toBe('unavailable');
    }
  });
});
