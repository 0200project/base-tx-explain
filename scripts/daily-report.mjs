#!/usr/bin/env node
/**
 * Daily discovery/monetization report. Zero dependencies, read-only.
 *
 *   npm run report
 *
 * Pulls: the server's own ledger (/stats), on-chain USDC truth (RPC balance
 * always; Blockscout transfer list when their API is up), GitHub repo traffic
 * (via the gh CLI when installed+authed), and the health of every discovery
 * listing. Writes reports/YYYY-MM-DD.md (gitignored) and prints a summary.
 * Every number is labeled with its source; anything unmeasurable says so
 * instead of guessing.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = process.env.PUBLIC_URL ?? 'https://base-tx-explain.fly.dev';
const WALLET = '0xd4ec730ab062f20460727710fce70664948a6bc9';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
/**
 * Before 2026-08-21 the server had no way to self-identify our own traffic, so
 * every client fingerprint - ours or a stranger's - counted the same way. This
 * baseline is that blind spot: unique_clients at the moment internal-call
 * marking shipped. external_clients (below) is authoritative for anything NEW
 * from here; this constant exists only to explain historical unique_clients,
 * which stays permanently overcounted for clients first seen before the fix.
 */
const PRE_MARKER_CLIENTS = 6;
/** Our own test payments: never count these as customer revenue. */
const KNOWN_PAYMENT_TXS = new Set([
  '0x2a2aaa3a79c3a394081df1a642046c88349a1397b27d97d8cb2292d71e61939f', // founder's $0.02 PayAI test, 2026-08-20 17:08 (pre-ledger)
]);
/**
 * Real, externally-funded payments that are still not revenue: a known
 * counterparty running a deliberate technical favor (e.g. Circadian-agent
 * exercising the in-band settlement path unprompted, 2026-08-21 - see
 * docs/finance.md, booked at $0.00 there for the same reason). These arrive
 * from a genuine external address, so they must NOT be lumped into
 * KNOWN_PAYMENT_TXS ("our own tests") - that would misrepresent who paid.
 * They also must NOT count toward the stranger/first-customer signal below -
 * that would misrepresent why they paid. Add the tx hash here the moment one
 * settles, with the same comment discipline as above.
 */
const KNOWN_FAVOR_TXS = new Set([
  // '0x...', // Circadian-agent in-band settlement probe, unprompted, not a sale
]);

const today = new Date().toISOString().slice(0, 10);
const lines = [];
const say = (s) => lines.push(s);

function statsToken() {
  try {
    return readFileSync(join(ROOT, '.stats-token'), 'utf8').trim();
  } catch {
    return process.env.STATS_TOKEN ?? '';
  }
}

async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

function gh(args) {
  try {
    return JSON.parse(execSync(`gh api ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 }));
  } catch {
    return null;
  }
}

// --- 1. Ledger (server source of truth for usage) ---
let stats = null;
try {
  stats = await jsonFetch(`${SERVER}/stats`, { headers: { 'X-Stats-Token': statsToken() } });
} catch (e) {
  say(`## Usage\n\nCould not read /stats (${e.message}). Server may be down or the token rotated.`);
}
if (stats) {
  const lt = stats.lifetime;
  const yesterday = stats.daily.at(-2);
  const todayRow = stats.daily.at(-1);
  say(`## Usage (source: server ledger)\n`);
  say(`Lifetime: ${lt.calls} calls · ${lt.free} free · ${lt.wall_hits} paywall hits · ${lt.paid_calls} payment attempts · ${lt.settlements} settlements ($${lt.revenue_usd}) · ${lt.unique_clients} unique clients`);
  if (typeof lt.external_clients === 'number') {
    const newSincePreMarker = Math.max(0, lt.external_clients - PRE_MARKER_CLIENTS);
    say(
      `External clients (never sent our internal marker): **${lt.external_clients}** ` +
        `- authoritative for anyone first seen after 2026-08-21; ${PRE_MARKER_CLIENTS} of those predate the marker ` +
        `and are an overcount inherited from before it existed. New external clients since the marker shipped: **${newSincePreMarker}**.`,
    );
  } else {
    say(`External-client marking not yet deployed on this server build; unique_clients (${lt.unique_clients}) cannot distinguish us from strangers.`);
  }
  for (const [label, row] of [['Today', todayRow], ['Yesterday', yesterday]]) {
    if (row) say(`${label} (${row.day}): ${row.calls} calls (${row.free} free / ${row.wall_hits} wall / ${row.paid_calls} pay-attempts), ${row.settlements} settled, ${row.unique_clients} clients`);
  }
  const last7 = stats.daily.slice(-7);
  const wk = (k) => last7.reduce((a, r) => a + r[k], 0);
  say(`Last 7 days: ${wk('calls')} calls · ${wk('wall_hits')} wall hits · ${wk('paid_calls')} payment attempts · $${wk('revenue_usd').toFixed(2)} settled`);
  say(`\n### Conversion funnel (lifetime)\n`);
  const pct = (a, b) => (b > 0 ? `${((100 * a) / b).toFixed(0)}%` : 'n/a');
  say(`free tester -> hit paywall: ${lt.wall_hits > 0 ? 'yes' : 'not yet'} (${lt.wall_hits} wall hits)`);
  say(`paywall hit -> payment attempted: ${pct(lt.paid_calls, lt.wall_hits)} (${lt.paid_calls}/${lt.wall_hits})`);
  say(`payment attempted -> settled: ${pct(lt.settlements, lt.paid_calls)} (${lt.settlements}/${lt.paid_calls})`);
  say(`Visitor -> tester is unmeasurable (static site, no analytics by design; Search Console pending founder signup).`);
}

// --- 1b. Risk-check availability ---
// A check that cannot run emits no flag, and no flag is indistinguishable from
// "looked and found nothing". Per-response `checks` tells one caller that; only
// this aggregate can say a check was dark for everybody, for a stretch of time.
// Reported when a check crossed either threshold below, so a quiet day is one
// line and an outage is named.
const DARK_HOURS_ALERT = 1; // any full hour where every attempt failed
const UNAVAILABLE_RATE_ALERT = 0.05; // 5% of attempts, over a floor of...
const MIN_ATTEMPTS_FOR_RATE = 20; // ...this many, so three calls cannot raise an alarm
if (stats?.check_health) {
  const h = stats.check_health;
  say(`\n## Risk-check availability (source: server ledger, last ${h.window_hours}h)\n`);
  const rows = Object.entries(h.checks ?? {});
  const alerts = rows.filter(
    ([, c]) =>
      c.dark_hours >= DARK_HOURS_ALERT ||
      (c.attempts >= MIN_ATTEMPTS_FOR_RATE && c.unavailable_rate >= UNAVAILABLE_RATE_ALERT),
  );
  for (const [name, c] of rows) {
    if (c.attempts === 0) {
      say(`- \`${name}\`: no traffic to measure (${c.not_applicable} responses had nothing for it to check)`);
      continue;
    }
    const rate = `${(c.unavailable_rate * 100).toFixed(1)}%`;
    const state = c.dark_hours > 0 ? `**DARK ${c.dark_hours}h**` : c.unavailable > 0 ? 'degraded' : 'answering';
    say(
      `- \`${name}\`: ${state} — ${c.attempts} ran, ${c.unavailable} unavailable (${rate})` +
        (c.inconclusive > 0 ? `, ${c.inconclusive} inconclusive` : '') +
        (c.last_unavailable_at ? `, last failing hour ${c.last_unavailable_at}` : ''),
    );
  }
  if (alerts.length > 0) {
    say(
      `\n**CHECK AVAILABILITY ALERT:** ${alerts.map(([n]) => `\`${n}\``).join(', ')} ` +
        `exceeded the threshold (any hour fully dark, or ${(UNAVAILABLE_RATE_ALERT * 100).toFixed(0)}% ` +
        `unavailable over ${MIN_ATTEMPTS_FOR_RATE}+ attempts). For that period the flag(s) behind it could ` +
        `not have fired, so an empty risk_flags in those responses means not checked, not clean.`,
    );
  } else if (rows.length > 0) {
    say(`\nNo check crossed the alert threshold in this window.`);
  }
  if (stats.check_health_7d) {
    const worst = Object.entries(stats.check_health_7d.checks ?? {})
      .filter(([, c]) => c.dark_hours > 0)
      .sort((a, b) => b[1].dark_hours - a[1].dark_hours);
    if (worst.length > 0) {
      say(
        `\n7-day worst: ${worst.map(([n, c]) => `\`${n}\` dark ${c.dark_hours}h`).join(', ')}.`,
      );
    }
  }
} else if (stats) {
  say(`\n## Risk-check availability\n`);
  say(`Not reported by this server build (needs the deploy that added \`check_health\` to /stats).`);
}

// --- 2. On-chain revenue truth ---
// This section covers the x402/USDC rail only. Stripe (fiat card payments,
// live-mode-gated as of 2026-08-21) settles to a bank account, never to this
// wallet - the two rails are genuinely separate, not a reconciliation bug.
// A real Stripe sale will never move this balance, so treat this section as
// "on-chain revenue," not "total revenue," once Stripe is live.
say(`\n## Revenue (source: Base chain - x402/USDC rail only, excludes Stripe)\n`);
try {
  const bal = await jsonFetch('https://mainnet.base.org', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: USDC, data: `0x70a08231000000000000000000000000${WALLET.slice(2)}` }, 'latest'] }),
  });
  const usdc = Number(BigInt(bal.result)) / 1e6;
  say(`Payout wallet USDC balance: **$${usdc.toFixed(2)}** (progress to $25 validation target: ${((usdc / 25) * 100).toFixed(0)}%)`);
} catch (e) {
  say(`RPC balance check failed (${e.message}).`);
}
try {
  const tx = await jsonFetch(`https://base.blockscout.com/api/v2/addresses/${WALLET}/token-transfers?type=ERC-20&filter=to`);
  const usdcTx = (tx.items ?? []).filter((t) => (t.token?.address_hash ?? t.token?.address ?? '').toLowerCase() === USDC.toLowerCase());
  const isOurs = (t) => KNOWN_PAYMENT_TXS.has((t.transaction_hash ?? '').toLowerCase());
  const isFavor = (t) => KNOWN_FAVOR_TXS.has((t.transaction_hash ?? '').toLowerCase());
  const favors = usdcTx.filter(isFavor);
  const strangers = usdcTx.filter((t) => !isOurs(t) && !isFavor(t));
  say(
    `On-chain USDC arrivals: ${usdcTx.length} total - ${usdcTx.length - strangers.length - favors.length} our own tests` +
      (favors.length > 0 ? `, ${favors.length} known non-revenue favor(s) (see docs/finance.md, booked $0)` : '') +
      `, **${strangers.length} unexplained external**.`,
  );
  if (strangers.length > 0) say(`FIRST CUSTOMER SIGNAL: unexplained external payment(s) present, not already accounted for as ours or a known favor - check the dashboard.`);
} catch {
  say(`Blockscout transfer list unavailable right now (their API); balance above is still authoritative.`);
}

// --- 3. Repo traffic (closest thing to "site analytics" we have) ---
say(`\n## Traffic (source: GitHub repo insights, 14-day window)\n`);
const views = gh('repos/0200project/base-tx-explain/traffic/views');
const clones = gh('repos/0200project/base-tx-explain/traffic/clones');
if (views) {
  say(`Repo views: ${views.count} total, ${views.uniques} unique visitors`);
  const recent = (views.views ?? []).slice(-3).map((v) => `${v.timestamp.slice(0, 10)}: ${v.count} (${v.uniques} uniq)`).join(' · ');
  if (recent) say(`Recent days: ${recent}`);
} else {
  say(`Repo views unavailable (gh CLI missing or unauthenticated).`);
}
if (clones) say(`Repo clones: ${clones.count} total, ${clones.uniques} unique`);
say(`Site page views: not collected (no analytics on the static site by design). Search queries: pending Google Search Console signup (founder queue).`);

// --- 4. Discovery surfaces ---
say(`\n## Discovery surfaces\n`);
const checks = [
  ['MCP registry', `https://registry.modelcontextprotocol.io/v0/servers?search=base-tx-explain`, (d) => {
    const latest = d.servers?.find((s) => s._meta?.['io.modelcontextprotocol.registry/official']?.isLatest);
    return latest ? `listed (v${latest.server.version})` : 'MISSING';
  }],
  ['Server /llms.txt', `${SERVER}/llms.txt`, null],
  ['Server /openapi.json', `${SERVER}/openapi.json`, (d) => `ok (v${d.info?.version})`],
  ['Site sitemap', 'https://0200project.com/sitemap.xml', null],
  ['Site (custom domain)', 'https://0200project.com/', null],
  ['Glama listing', 'https://glama.ai/mcp/servers/0200project/base-tx-explain', null],
  ['Apify Store listing', 'https://apify.com/0200project/base-tx-explain', null],
];
// PPE pricing visibility: once the founder flips the model and the 14-day
// notice elapses (~Sept 3), the listing should show per-event pricing. Until
// then an Apify $0 is structural - the day-14 gate is judged on x402 only.
try {
  const page = await (await fetch('https://apify.com/0200project/base-tx-explain', { signal: AbortSignal.timeout(15_000) })).text();
  // Only markers Apify's own pricing UI produces: our README (embedded on the
  // page) says "$0.02" and "explain_transaction" with an underscore, so those
  // would false-positive; the PPE event name uses a hyphen.
  const ppeVisible = /pay per event/i.test(page) || page.includes('explain-transaction');
  say(`- Apify PPE pricing visible on listing: ${ppeVisible ? 'YES' : 'not yet (billing cannot start before ~Sept 3; structural, not a failed channel)'}`);
} catch {
  say(`- Apify PPE pricing check failed this run.`);
}
for (const [name, url, parse] of checks) {
  try {
    if (parse) {
      const d = await jsonFetch(url);
      say(`- ${name}: ${parse(d)}`);
    } else {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      say(`- ${name}: ${res.ok ? 'ok' : `HTTP ${res.status}`}`);
    }
  } catch (e) {
    say(`- ${name}: FAILED (${e.message})`);
  }
}
for (const [name, repo, head] of [
  ['awesome-mcp-servers PR', 'punkpeye/awesome-mcp-servers', '0200project:add-base-tx-explain'],
  ['x402 ecosystem PR', 'coinbase/x402', '0200project:add-base-tx-explain'],
]) {
  try {
    const prs = gh(`"repos/${repo}/pulls?head=${head}&state=all"`);
    say(prs?.length ? `- ${name}: #${prs[0].number} ${prs[0].state}${prs[0].merged_at ? ' (merged)' : ''}` : `- ${name}: not found`);
  } catch {
    say(`- ${name}: check failed`);
  }
}
say(`- Coinbase Bazaar: BLOCKED (CDP rejects our payment payloads; see docs/NEXT-STEPS.md)`);

// --- write + print ---
const report = `# Daily report - ${today}\n\n${lines.join('\n')}\n`;
mkdirSync(join(ROOT, 'reports'), { recursive: true });
const out = join(ROOT, 'reports', `${today}.md`);
writeFileSync(out, report);
console.log(report);
console.log(`Written to ${out}`);
