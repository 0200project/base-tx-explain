import type { Address } from 'viem';
import { DAY, FOREVER, NEGATIVE_TTL, TtlCache } from '../cache.js';
import { client } from '../rpc.js';

type VerificationStatus = 'verified' | 'unverified' | 'eoa' | 'unknown';

const cache = new TtlCache<VerificationStatus>(10_000, DAY);

/**
 * Is there verified source code for this address?
 * Sourcify first (keyless), Etherscan v2 as fallback when a key is configured.
 * "unknown" (both providers unreachable) must never produce a risk flag.
 */
export async function verificationStatus(address: Address): Promise<VerificationStatus> {
  // 'unknown' is a transient failure, not a fact about the contract, and this
  // cache is keyed on address alone — so caching it for a full day let a single
  // Sourcify blip suppress unverified_contract for that contract for 24 hours,
  // across every transaction and every client. Measured case: Blockscout was
  // down for roughly 16 minutes on 2026-08-20 and would have poisoned entries
  // long after it recovered. Real answers still cache for a day.
  return cache.getOrLoad(
    address.toLowerCase(),
    async () => {
      let code: string | undefined;
      try {
        code = await client.getCode({ address });
      } catch {
        return 'unknown';
      }
      // No code, or a bare EIP-7702 delegation marker (23 bytes): not a contract to audit.
      if (!code || code === '0x' || code.length <= 48) return 'eoa';

      const sourcify = await checkSourcify(address);
      if (sourcify !== 'unknown') return sourcify;
      return checkEtherscan(address);
    },
    (v) => (v === 'unknown' ? NEGATIVE_TTL : DAY),
  );
}

async function checkSourcify(address: Address): Promise<VerificationStatus> {
  try {
    const res = await fetch(`https://sourcify.dev/server/v2/contract/8453/${address}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 404) return 'unverified';
    if (!res.ok) return 'unknown';
    const body = (await res.json()) as { match?: string | null };
    return body.match ? 'verified' : 'unverified';
  } catch {
    return 'unknown';
  }
}

async function checkEtherscan(address: Address): Promise<VerificationStatus> {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) return 'unknown';
  try {
    const url = `https://api.etherscan.io/v2/api?chainid=8453&module=contract&action=getabi&address=${address}&apikey=${key}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return 'unknown';
    const body = (await res.json()) as { status?: string; result?: string };
    if (body.status === '1') return 'verified';
    if (typeof body.result === 'string' && body.result.includes('not verified')) return 'unverified';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
