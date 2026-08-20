import { toEventSelector, type AbiEvent, type Address, type Hex } from 'viem';
import { DAY, FOREVER, TtlCache } from '../cache.js';

const cache = new TtlCache<Map<Hex, string> | null>(5_000, FOREVER);

/**
 * topic0 → event name for a contract, from its VERIFIED ABI on Sourcify.
 * Lets the explainer name app-specific events it has no builtin decoder for —
 * an honest middle ground between full decode and "unrecognized event".
 * Returns null for unverified contracts / fetch failures (cached briefly).
 */
export async function getVerifiedEventNames(address: Address): Promise<Map<Hex, string> | null> {
  const key = address.toLowerCase();
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  try {
    const res = await fetch(`https://sourcify.dev/server/v2/contract/8453/${address}?fields=abi`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      cache.set(key, null, DAY);
      return null;
    }
    const body = (await res.json()) as { abi?: Array<{ type: string; name?: string; inputs?: unknown[] }> };
    if (!Array.isArray(body.abi)) {
      cache.set(key, null, DAY);
      return null;
    }
    const map = new Map<Hex, string>();
    for (const item of body.abi) {
      if (item.type !== 'event' || !item.name) continue;
      try {
        map.set(toEventSelector(item as unknown as AbiEvent), item.name);
      } catch {
        // Skip events the selector encoder cannot handle.
      }
    }
    cache.set(key, map);
    return map;
  } catch {
    cache.set(key, null, DAY);
    return null;
  }
}
