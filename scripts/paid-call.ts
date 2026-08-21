/**
 * End-to-end paid-call test: connects as a real x402 MCP buyer, burns any
 * remaining free calls, then PAYS $0.02 USDC on Base for a call and prints
 * the settlement. The first genuine settlement is also what lists this
 * server in the facilitator's public catalog (which x402scan syncs).
 *
 * Usage:
 *   X402_TEST_PRIVATE_KEY=0x... npx tsx scripts/paid-call.ts [server-url] [tx-hash]
 *
 * The key must be the throwaway TEST wallet holding ~$1 USDC on Base.
 * NEVER the payout wallet, never a personal wallet. The exact scheme uses an
 * EIP-3009 authorization, so the test wallet needs no ETH for gas.
 */
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { createx402MCPClient } from '@x402/mcp';
import { privateKeyToAccount } from 'viem/accounts';

const SERVER_URL = process.argv[2] ?? 'https://base-tx-explain.fly.dev/mcp';
const TX_HASH =
  process.argv[3] ?? '0x0c84b951051f779903b57af9225ca570c77cd5531195968dd78106a69d6c4d8c';

const key = process.env.X402_TEST_PRIVATE_KEY;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error(
    'Set X402_TEST_PRIVATE_KEY to the throwaway test wallet key (0x + 64 hex).\n' +
      'That wallet needs a little USDC on Base. Never use the payout or a personal wallet.',
  );
  process.exit(1);
}

const account = privateKeyToAccount(key as `0x${string}`);
console.log(`Buyer wallet: ${account.address}`);
console.log(`Server:       ${SERVER_URL}\n`);

const client = createx402MCPClient({
  name: 'base-tx-explain-paid-test',
  version: '0.0.1',
  schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(account) }],
  onPaymentRequested: async ({ paymentRequired }) => {
    const a = paymentRequired.accepts[0];
    console.log(`  -> 402 received: ${a?.amount} units of ${a?.asset} to ${a?.payTo}. Paying...`);
    return true;
  },
});

/**
 * Mark this run as ours, so a test payment does not land in the ledger looking
 * like a stranger who paid.
 *
 * This script had no marker until now, and it cost real analyst time: two paid
 * calls it made on 2026-08-21 at 17:26 showed up as `internal: false` and had
 * to be run down by hand before they could be ruled out as a new customer. The
 * script that exists to simulate a buyer is, unsurprisingly, the single most
 * convincing counterfeit customer we can produce.
 *
 * Unset means unmarked, never a guess: an absent INTERNAL_MARKER makes this run
 * look external, which is the cheap mistake (we investigate ourselves) rather
 * than the expensive one (a real stranger dismissed as internal). The warning
 * below exists so that choice is visible at the time rather than an hour later.
 */
const marker = process.env.INTERNAL_MARKER ?? '';
if (!marker) {
  console.warn(
    'WARNING: INTERNAL_MARKER is not set, so this run will be counted as EXTERNAL\n' +
      '         traffic in the ledger and somebody will have to rule it out by hand.\n' +
      '         Set it from .internal-marker before running against production.\n',
  );
}

await client.connect(
  new StreamableHTTPClientTransport(new URL(SERVER_URL), {
    requestInit: marker ? { headers: { 'x-btx-internal': marker } } : undefined,
  }),
);

try {
for (let i = 1; i <= 12; i++) {
  const result = await client.callTool('explain_transaction', { tx_hash: TX_HASH });
  const first = result.content.find((c) => c.type === 'text') as { text?: string } | undefined;
  // Never let an unparseable body crash the run: the body IS the diagnosis.
  let parsed: Record<string, unknown> | null = null;
  if (first?.text) {
    try {
      parsed = JSON.parse(first.text) as Record<string, unknown>;
    } catch {
      console.log(`call ${i}: response was not JSON. Raw body:`);
      console.log(first.text.slice(0, 1500));
      console.log('\nFull content array:', JSON.stringify(result.content).slice(0, 800));
      break;
    }
  }
  const summary = parsed?.summary ?? parsed?.error ?? '(no summary)';
  console.log(`call ${i}: paid=${result.paymentMade} isError=${result.isError ?? false} | ${String(summary).slice(0, 80)}`);
  if (result.paymentMade) {
    if (result.isError || !parsed?.summary) {
      console.log('\nPAYMENT SENT BUT THE RESULT IS NOT A DECODE - raw response follows:');
      console.log((first?.text ?? '(empty)').slice(0, 1200));
      console.log('\nsettlement:', JSON.stringify(result.paymentResponse ?? null));
      console.log('This usually means verification or settlement FAILED server-side; no funds moved.');
      break;
    }
    console.log('\nPAID CALL SETTLED.');
    console.log('settlement:', JSON.stringify(result.paymentResponse, null, 2));
    console.log('\nCheck the payout wallet on Basescan - the $0.02 should be there.');
    break;
  }
  if (i === 12) console.log('\nNever hit the paywall - free-tier counter may have reset; rerun.');
}
} catch (err) {
  console.log('\nTHREW during the call loop:');
  console.log(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  const cause = (err as { cause?: unknown }).cause;
  if (cause) console.log('cause:', String(cause).slice(0, 500));
  const data = (err as { data?: unknown }).data;
  if (data) console.log('data:', JSON.stringify(data).slice(0, 800));
}

await client.close();
process.exit(0);
