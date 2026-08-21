import { formatUnits, type Address } from 'viem';
import { client } from './rpc.js';

/**
 * Payout-wallet balance, read from the chain we already talk to.
 *
 * The dashboard used to fetch this from a public explorer API in the browser,
 * which meant the one number the founder actually checks disappeared whenever
 * that third party had a bad day — and it was returning HTTP 500 when this was
 * written. We already hold a Base RPC client with failover across three
 * providers, so the balance is a direct read with no new dependency and no
 * cross-origin exposure.
 */

const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const CACHE_MS = 30_000;

export interface TreasurySnapshot {
  /** Decimal USDC held by the payout wallet, or null when the read failed. */
  usdc_balance: number | null;
  wallet: string;
  /** When this was read, so a stale number is visibly stale. */
  read_at: string | null;
  /** Present only on failure, so the dashboard can say why instead of showing nothing. */
  error?: string;
}

let cached: TreasurySnapshot | null = null;
let cachedAt = 0;
let inflight: Promise<TreasurySnapshot> | null = null;

export async function getTreasury(payoutWallet: string): Promise<TreasurySnapshot> {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_MS) return cached;
  if (inflight) return inflight;

  inflight = (async (): Promise<TreasurySnapshot> => {
    try {
      const raw = await client.readContract({
        address: USDC,
        abi: BALANCE_ABI,
        functionName: 'balanceOf',
        args: [payoutWallet as Address],
      });
      const snap: TreasurySnapshot = {
        usdc_balance: Number.parseFloat(formatUnits(raw, 6)),
        wallet: payoutWallet,
        read_at: new Date().toISOString(),
      };
      cached = snap;
      cachedAt = Date.now();
      return snap;
    } catch (err) {
      // Serve the last good number rather than nothing: a slightly stale
      // balance is more useful than a blank panel, and read_at shows its age.
      if (cached) return { ...cached, error: 'refresh failed, showing last known balance' };
      return {
        usdc_balance: null,
        wallet: payoutWallet,
        read_at: null,
        error: err instanceof Error ? err.message.slice(0, 120) : 'balance read failed',
      };
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}
