import { createPublicClient, fallback, http } from 'viem';
import { base } from 'viem/chains';

const DEFAULT_RPCS = [
  'https://mainnet.base.org',
  'https://base-rpc.publicnode.com',
  'https://base.llamarpc.com',
].join(',');

const urls = (process.env.BASE_RPC_URLS ?? DEFAULT_RPCS)
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);

/**
 * Public client for Base mainnet. The `base` chain definition carries the
 * OP-stack formatters, so transaction receipts include the L1 data fee
 * (`l1Fee`) needed for an honest gas_paid_usd.
 */
export const client = createPublicClient({
  chain: base,
  transport: fallback(
    urls.map((url) => http(url, { retryCount: 2, timeout: 15_000 })),
    { rank: false },
  ),
  batch: { multicall: true },
});
