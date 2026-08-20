/**
 * Verify candidate label-table entries against the chain before they are trusted.
 *
 * A wrong entry in src/labels.ts is worse than a missing one: a labeled address
 * is treated as canonical for its ticker by the impersonation guard AND has its
 * unverified_contract / first_time_counterparty checks suppressed. So an
 * impostor added by mistake would be actively vouched for. Research says what an
 * address SHOULD be; this says what it actually IS on Base mainnet.
 *
 * Usage: npx tsx scripts/verify-labels.ts candidates.json
 *   [{ "label": "USDT", "address": "0x...", "category": "token",
 *      "symbol_or_name": "USDT", "decimals": 6, "source_url": "..." }]
 */
import { readFileSync } from 'node:fs';
import { getAddress, type Address } from 'viem';
import { getLabel } from '../src/labels.js';
import { client } from '../src/rpc.js';

interface Candidate {
  label: string;
  address: string;
  category: string;
  symbol_or_name?: string;
  decimals?: number | null;
  source_url?: string;
  confidence?: string;
}

const STRING_FN = (name: string) =>
  [{ type: 'function', name, stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }] as const;
const DECIMALS_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

async function readStr(address: Address, fn: 'symbol' | 'name'): Promise<string | null> {
  try {
    return (await client.readContract({ address, abi: STRING_FN(fn), functionName: fn })) as string;
  } catch {
    return null;
  }
}

const file = process.argv[2];
if (!file) {
  console.error('usage: npx tsx scripts/verify-labels.ts candidates.json');
  process.exit(1);
}
const candidates = JSON.parse(readFileSync(file, 'utf8')) as Candidate[];

let pass = 0;
let fail = 0;

for (const c of candidates) {
  const problems: string[] = [];
  let checksummed: Address;
  try {
    checksummed = getAddress(c.address);
  } catch {
    console.log(`REJECT  ${c.label.padEnd(24)} malformed address ${c.address}`);
    fail++;
    continue;
  }

  const code = await client.getCode({ address: checksummed }).catch(() => undefined);
  if (!code || code === '0x') problems.push('NO CONTRACT CODE at this address');

  const already = getLabel(checksummed);
  if (already) problems.push(`already labeled as "${already.label}"`);

  let onchainSymbol: string | null = null;
  let onchainDecimals: number | null = null;

  if (c.category === 'token') {
    onchainSymbol = await readStr(checksummed, 'symbol');
    try {
      onchainDecimals = await client.readContract({ address: checksummed, abi: DECIMALS_ABI, functionName: 'decimals' });
    } catch {
      onchainDecimals = null;
    }
    if (onchainSymbol === null) problems.push('symbol() unreadable - is this really an ERC-20?');
    else if (c.symbol_or_name && onchainSymbol.toLowerCase() !== c.symbol_or_name.toLowerCase()) {
      problems.push(`symbol MISMATCH: chain says "${onchainSymbol}", research said "${c.symbol_or_name}"`);
    }
    if (onchainDecimals === null) problems.push('decimals() unreadable');
    else if (typeof c.decimals === 'number' && onchainDecimals !== c.decimals) {
      problems.push(`decimals MISMATCH: chain says ${onchainDecimals}, research said ${c.decimals}`);
    }
  } else {
    onchainSymbol = await readStr(checksummed, 'name');
  }

  if (c.confidence && c.confidence !== 'high') problems.push(`research confidence only "${c.confidence}"`);
  if (!c.source_url) problems.push('no source url');

  const detail = c.category === 'token'
    ? `symbol=${JSON.stringify(onchainSymbol)} decimals=${onchainDecimals}`
    : `name=${JSON.stringify(onchainSymbol)}`;

  if (problems.length === 0) {
    console.log(`OK      ${c.label.padEnd(24)} ${checksummed}  ${detail}`);
    pass++;
  } else {
    console.log(`REJECT  ${c.label.padEnd(24)} ${checksummed}  ${detail}`);
    for (const p of problems) console.log(`        - ${p}`);
    fail++;
  }
}

console.log(`\n${pass} verified, ${fail} rejected.`);
console.log('Only entries printed OK should be added to src/labels.ts.');
process.exit(fail > 0 ? 1 : 0);
