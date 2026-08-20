import { hexToString, isHex, type Address } from 'viem';
import { DAY, FOREVER, TtlCache } from '../cache.js';
import { LABELS } from '../labels.js';
import { client } from '../rpc.js';

// Ticker -> canonical address for the tokens we label, so a contract cannot
// impersonate a known token (e.g. render as "USDC") by self-reporting a famous
// symbol from an address that is not the real one.
const KNOWN_TOKEN_ADDRESSES = new Map<string, string>(
  Object.entries(LABELS)
    .filter(([, l]) => l.category === 'token')
    .map(([addr, l]) => [l.label.replace(/\s*\(.*$/, '').trim().toLowerCase(), addr.toLowerCase()] as const),
);

/**
 * Trust status of a token's self-reported symbol:
 *  - `ok`            — a plausible ticker we are willing to show.
 *  - `nonstandard`   — not a standard ticker (emoji/homoglyph/promo/instruction
 *                      text); `symbol` shows the address instead.
 *  - `impersonation` — a valid ticker that matches a KNOWN token, but from a
 *                      non-canonical address (active deception); shows the address.
 */
export type SymbolStatus = 'ok' | 'nonstandard' | 'impersonation';

export interface TokenMeta {
  symbol: string;
  decimals: number;
  symbolStatus?: SymbolStatus;
}

const metaCache = new TtlCache<TokenMeta | null>(10_000, FOREVER);

const ERC20_META_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

const BYTES32_SYMBOL_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
] as const;

/**
 * symbol + decimals for an ERC-20, cached for the process lifetime.
 * Handles bytes32-symbol tokens (MKR-style). Returns null for contracts that
 * expose neither — callers fall back to a shortened address.
 */
export async function getTokenMeta(address: Address): Promise<TokenMeta | null> {
  return metaCache.getOrLoad(address.toLowerCase(), async () => {
    let decimals: number;
    try {
      decimals = await client.readContract({ address, abi: ERC20_META_ABI, functionName: 'decimals' });
    } catch {
      return null;
    }
    try {
      const symbol = await client.readContract({ address, abi: ERC20_META_ABI, functionName: 'symbol' });
      return { symbol: displaySymbol(symbol, address), decimals, symbolStatus: symbolStatus(symbol, address) };
    } catch {
      try {
        const raw = await client.readContract({ address, abi: BYTES32_SYMBOL_ABI, functionName: 'symbol' });
        if (isHex(raw)) {
          const symbol = hexToString(raw).replace(/ +$/g, '');
          if (symbol) return { symbol: displaySymbol(symbol, address), decimals, symbolStatus: symbolStatus(symbol, address) };
        }
      } catch {
        // fall through
      }
      return { symbol: shortAddress(address), decimals };
    }
  });
}

/** NFT collection name (or symbol) for 721/1155 contracts; null when unavailable. */
const NAME_ABI = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;

const nameCache = new TtlCache<string | null>(10_000, FOREVER);

export async function getContractName(address: Address): Promise<string | null> {
  return nameCache.getOrLoad(address.toLowerCase(), async () => {
    try {
      const name = await client.readContract({ address, abi: NAME_ABI, functionName: 'name' });
      return name ? sanitizeSymbol(name) || null : null;
    } catch {
      return null;
    }
  });
}

// Cached ERC-20 totalSupply, used to judge whether an approval is effectively
// unlimited (an allowance at or above the whole supply can never be a real,
// bounded amount). DAY TTL, not FOREVER, so a transient read failure self-heals.
const supplyCache = new TtlCache<bigint | null>(10_000, DAY);
const TOTAL_SUPPLY_ABI = [
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

export async function getTokenSupply(address: Address): Promise<bigint | null> {
  return supplyCache.getOrLoad(address.toLowerCase(), async () => {
    try {
      return await client.readContract({ address, abi: TOTAL_SUPPLY_ABI, functionName: 'totalSupply' });
    } catch {
      return null;
    }
  });
}

/**
 * Third-party token symbols and names flow into `summary` and assets_moved,
 * which are read by other agents' LLMs — so a hostile contract must not smuggle
 * instructions, homoglyphs, line breaks, or promotional copy through them.
 * NFKC-fold, then drop control/format, line/paragraph separators (incl.
 * U+2028/U+2029, which JSON.stringify emits raw), and combining marks; keep only
 * letters, digits, and a small punctuation set (drops emoji and other symbols —
 * also the project's no-emoji house style); collapse whitespace; cap length.
 * Character hygiene ONLY: it does not make the value trustworthy. See the
 * `provenance` block on the result, and `displaySymbol` for the ticker path.
 */
export function sanitizeSymbol(raw: string): string {
  const cleaned = raw
    .normalize('NFKC')
    .replace(/[\p{C}\p{Zl}\p{Zp}\p{M}]/gu, '')
    .replace(/[^\p{L}\p{N} .,_+\-/()]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return cleaned.length > 32 ? `${cleaned.slice(0, 29)}...` : cleaned;
}

/** A real ERC-20 ticker is short ASCII. */
const TICKER = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,15}$/;

/**
 * Is the contract's self-reported symbol a plausible ticker? Checked on the RAW
 * value, BEFORE any normalization: NFKC-folding first would let a fullwidth
 * impostor (ＵＳＤＣ) collapse to a clean "USDC" and pass, manufacturing a perfect
 * impersonation out of an imperfect one.
 */
export function isStandardTicker(raw: string): boolean {
  return TICKER.test(raw.trim());
}

/**
 * Classify a contract's self-reported symbol. A non-ticker is `nonstandard`; a
 * valid ticker that collides with a token we label but comes from a different
 * address is `impersonation` (active deception). NOTE: this catch is only as
 * wide as the label table — a fake "USDC" is caught, a fake "USDT" is not, until
 * that token's canonical address is added. Everything else is a deliberate `ok`:
 * most tokens are legitimate and unlabeled, and we show their symbol as given.
 */
export function symbolStatus(raw: string, address: string): SymbolStatus {
  const t = raw.trim();
  if (!isStandardTicker(t)) return 'nonstandard';
  const canonical = KNOWN_TOKEN_ADDRESSES.get(t.toLowerCase());
  if (canonical && canonical !== address.toLowerCase()) return 'impersonation';
  return 'ok';
}

/**
 * Symbol to show for a token. A genuine ERC-20 symbol is a short ASCII ticker
 * and, when it names a token we know, must come from that token's canonical
 * address. Anything else (emoji, homoglyphs, fullwidth forms, spaces,
 * promotional or instruction-shaped text, or a famous ticker from the wrong
 * address) is not trustworthy as an identity, so we show the contract address.
 */
export function displaySymbol(raw: string, address: string): string {
  return symbolStatus(raw, address) === 'ok' ? raw.trim() : shortAddress(address);
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
