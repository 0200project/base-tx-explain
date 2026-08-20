/**
 * One-command business check: has a stranger used it, and has anyone paid?
 *
 *   npm run status
 *
 * Reads the server's own ledger plus the payout wallet's on-chain balance.
 * KNOWN_CLIENTS is the baseline of clients that are us (the founder's machine
 * and the sessions that built this); anything above that count is somebody new.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SERVER = process.env.PUBLIC_URL ?? 'https://base-tx-explain.fly.dev';
const PAYOUT_WALLET = '0xd4ec730ab062f20460727710fce70664948a6bc9';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/** Unique clients recorded while only we were calling it (2026-08-20). */
const KNOWN_CLIENTS = 2;

function readToken(): string {
  try {
    return readFileSync(fileURLToPath(new URL('../.stats-token', import.meta.url)), 'utf8').trim();
  } catch {
    return process.env.STATS_TOKEN ?? '';
  }
}

async function usdcBalance(address: string): Promise<number | null> {
  try {
    const res = await fetch('https://mainnet.base.org', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: USDC, data: `0x70a08231000000000000000000000000${address.slice(2)}` }, 'latest'],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as { result?: string };
    if (!body.result) return null;
    return Number(BigInt(body.result)) / 1e6;
  } catch {
    return null;
  }
}

const token = readToken();
if (!token) {
  console.error('No stats token found (.stats-token or STATS_TOKEN).');
  process.exit(1);
}

const [statsRes, balance] = await Promise.all([
  fetch(`${SERVER}/stats`, { headers: { 'x-stats-token': token }, signal: AbortSignal.timeout(20_000) }),
  usdcBalance(PAYOUT_WALLET),
]);

if (!statsRes.ok) {
  console.error(`Stats endpoint returned ${statsRes.status}. Is the server up?`);
  process.exit(1);
}

const stats = (await statsRes.json()) as {
  lifetime: { calls: number; free: number; wall_hits: number; paid_calls: number; settlements: number; revenue_usd: number; unique_clients: number };
  daily: Array<{ day: string; calls: number; unique_clients: number; paid_calls: number; settlements: number; revenue_usd: number }>;
};

const lt = stats.lifetime;
const strangers = lt.unique_clients - KNOWN_CLIENTS;

console.log('');
console.log('  base-tx-explain');
console.log('  ' + '-'.repeat(46));
console.log(`  wallet balance     $${(balance ?? 0).toFixed(2)} USDC${balance === null ? ' (lookup failed)' : ''}`);
console.log(`  settled payments   ${lt.settlements}`);
console.log(`  total calls        ${lt.calls}  (${lt.free} free, ${lt.paid_calls} with payment)`);
console.log(`  paywall hits       ${lt.wall_hits}  (someone ran out of free calls)`);
console.log(`  unique clients     ${lt.unique_clients}  (baseline ${KNOWN_CLIENTS} = us)`);
console.log('');

if (strangers > 0) {
  console.log(`  *** ${strangers} STRANGER${strangers === 1 ? '' : 'S'} HAVE CALLED IT ***`);
  console.log(lt.settlements > 0
    ? '  And a payment has settled. That is the signal you were waiting for.'
    : '  None have paid yet. A paywall hit means one considered it.');
} else {
  console.log('  No strangers yet. Every call so far is ours.');
}

const active = stats.daily.filter((d) => d.calls > 0).slice(-7);
if (active.length > 0) {
  console.log('');
  console.log('  recent days');
  for (const d of active) {
    console.log(`    ${d.day}  calls ${String(d.calls).padStart(4)}  clients ${String(d.unique_clients).padStart(3)}  paid ${d.paid_calls}  $${d.revenue_usd.toFixed(2)}`);
  }
}
console.log('');
