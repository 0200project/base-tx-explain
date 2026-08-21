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
  // Present from v0.1.3 on. Older deploys omit it, so every use is guarded.
  reconciliation?: {
    status: 'reconciled' | 'unbooked_revenue' | 'overbooked' | 'unknown';
    booked_usd: number;
    wallet_usd: number | null;
    withdrawn_usd: number;
    received_usd: number | null;
    delta_usd: number | null;
    unbooked_paid_calls: number;
    unbooked_notional_usd: number;
    note: string;
  };
  // Present from v0.1.3 on. Older deploys omit it, so every use is guarded.
  check_health?: CheckHealth;
  check_health_7d?: CheckHealth;
};

interface CheckHealth {
  window_hours: number;
  observed_hours: number;
  checks: Record<string, {
    ok: number;
    partial: number;
    unavailable: number;
    inconclusive: number;
    not_applicable: number;
    attempts: number;
    unavailable_rate: number;
    dark_hours: number;
    last_unavailable_at: string | null;
  }>;
}

const lt = stats.lifetime;
const rec = stats.reconciliation;
const strangers = lt.unique_clients - KNOWN_CLIENTS;
// Prefer the server's reading (same Base RPC client, with failover) and fall
// back to the direct lookup so this still works against an older deploy.
const walletUsd = rec?.wallet_usd ?? balance;

console.log('');
console.log('  base-tx-explain');
console.log('  ' + '-'.repeat(46));
console.log(`  wallet balance     $${(walletUsd ?? 0).toFixed(2)} USDC${walletUsd === null ? ' (lookup failed)' : ''}`);
console.log(`  booked revenue     $${lt.revenue_usd.toFixed(2)}  (${lt.settlements} settled payment${lt.settlements === 1 ? '' : 's'})`);
if (rec && rec.delta_usd !== null) {
  // The number this check exists for: money on chain the ledger never booked.
  const d = rec.delta_usd;
  const label = d > 0 ? 'unbooked' : d < 0 ? 'OVERBOOKED' : 'difference';
  console.log(`  ${label.padEnd(17)}  $${Math.abs(d).toFixed(2)}${d > 0 ? '  (arrived on chain, never recorded)' : d < 0 ? '  (booked but not on chain)' : '  (ledger matches the chain)'}`);
} else if (rec) {
  console.log('  unbooked            unknown  (wallet balance could not be read)');
}
console.log(`  total calls        ${lt.calls}  (${lt.free} free, ${lt.paid_calls} arrived with a payment attached)`);
console.log(`  paywall hits       ${lt.wall_hits}  (someone ran out of free calls)`);
console.log(`  unique clients     ${lt.unique_clients}  (baseline ${KNOWN_CLIENTS} = us)`);
console.log('');

if (rec && rec.status !== 'reconciled') {
  console.log(`  ${rec.note}`);
  console.log('');
}

if (strangers > 0) {
  console.log(`  *** ${strangers} STRANGER${strangers === 1 ? '' : 'S'} HAVE CALLED IT ***`);
  // "Nobody paid" must key off the chain, not off the booked counter: money can
  // arrive without a settlement being booked, and this line is the one the
  // founder reads to decide whether the funnel converts.
  const reachedWallet = (rec?.received_usd ?? 0) > 0;
  console.log(
    lt.settlements > 0
      ? '  And a payment has settled. That is the signal you were waiting for.'
      : reachedWallet
        ? '  Money has reached the wallet, but no settlement was booked - see the unbooked line above.'
        : '  None have paid yet. A paywall hit means one considered it.');
} else {
  console.log('  No strangers yet. Every call so far is ours.');
}

// Risk-check availability. A check that could not run emits no flag, and no
// flag looks exactly like nothing found - so a check that was dark is a quiet
// reduction in what the product does, and the only place it shows up is here.
const health = stats.check_health;
if (health) {
  console.log('');
  console.log(`  risk checks (last ${health.window_hours}h, ${health.observed_hours}h with traffic)`);
  for (const [name, c] of Object.entries(health.checks)) {
    if (c.attempts === 0) {
      console.log(`    ${name.padEnd(22)} no traffic to measure`);
      continue;
    }
    const rate = `${(c.unavailable_rate * 100).toFixed(1)}%`;
    const state =
      c.dark_hours > 0
        ? `DARK ${c.dark_hours}h`
        : c.unavailable > 0
          ? 'degraded'
          : c.partial > 0
            ? 'partial coverage'
            : 'answering';
    console.log(
      `    ${name.padEnd(22)} ${String(c.attempts).padStart(5)} ran  ${String(c.unavailable).padStart(4)} unavailable (${rate.padStart(5)})  ${state}`,
    );
  }
  const dark = Object.entries(health.checks).filter(([, c]) => c.dark_hours > 0);
  for (const [name, c] of dark) {
    console.log('');
    console.log(
      `  *** ${name} WAS DARK FOR ${c.dark_hours} CONSECUTIVE HOUR${c.dark_hours === 1 ? '' : 'S'} ***`,
    );
    console.log(`  Every attempt failed in that window, so no flag it produces could have fired.`);
    if (c.last_unavailable_at) console.log(`  Most recent failing hour: ${c.last_unavailable_at}`);
  }
  const week = stats.check_health_7d;
  if (week) {
    const worst = Object.entries(week.checks).sort((a, b) => b[1].dark_hours - a[1].dark_hours)[0];
    if (worst && worst[1].dark_hours > 0 && dark.length === 0) {
      console.log('');
      console.log(`  Worst in the last 7 days: ${worst[0]}, dark for ${worst[1].dark_hours}h.`);
    }
  }
}

const active = stats.daily.filter((d) => d.calls > 0).slice(-7);
if (active.length > 0) {
  console.log('');
  console.log('  recent days');
  for (const d of active) {
    console.log(`    ${d.day}  calls ${String(d.calls).padStart(4)}  clients ${String(d.unique_clients).padStart(3)}  pay-attempts ${d.paid_calls}  settled $${d.revenue_usd.toFixed(2)}`);
  }
}
console.log('');
