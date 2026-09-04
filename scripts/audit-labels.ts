/**
 * Audit the SHIPPED label table against Base mainnet.
 *
 * WHY THIS EXISTS SEPARATELY FROM verify-labels.ts, which looks like it already
 * does this and cannot: that script is an INTAKE gate for new candidates, and
 * line 66 pushes a problem when `getLabel(address)` already returns something.
 * Every existing entry therefore REJECTS by construction. Pointed at the current
 * table it reports 0 passed / 99 rejected — a confident number that says nothing
 * about currency. A tool that cannot answer the question is not a tool that
 * answered it.
 *
 * A wrong entry is worse than a missing one: a labeled address has its
 * unverified_contract and first_time_counterparty checks SUPPRESSED, so an
 * impostor entered by mistake is actively vouched for by us.
 *
 * ⚠️ DELIBERATELY NOT IN predeploy.sh. It makes ~99 on-chain calls, so wiring it
 * to the deploy gate would block shipping whenever a public RPC is rate-limited
 * — converting a third-party hiccup into our own outage, which is the same
 * mistake as gating liveness on the payment facilitator. This is a PERIODIC
 * audit, run by a human or a schedule. Availability of the answer and permission
 * to deploy are different questions.
 *
 * Usage: npx tsx scripts/audit-labels.ts
 * Exit 1 if any entry has no code or a symbol that disagrees with its ticker.
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, http, type Address } from 'viem';
import { base } from 'viem/chains';

const RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.llamarpc.com'];
const clients = RPCS.map((u) => createPublicClient({ chain: base, transport: http(u) }));

// Read the table out of the SOURCE, so the audit checks what ships rather than
// what an import would give us after any normalisation.
const src = readFileSync(new URL('../src/labels.ts', import.meta.url), 'utf8');
const ENTRY = /'(0x[0-9a-fA-F]{40})':\s*\{\s*label:\s*'([^']+)',\s*category:\s*'([^']+)'/g;
const rows = [...src.matchAll(ENTRY)].map((m) => ({ addr: m[1] as Address, label: m[2], cat: m[3] }));

// A parse that silently matched nothing would print "0 problems" and read as a
// pass. Refuse to report on a suspicious harvest rather than emit a clean zero.
if (rows.length < 90) {
  console.error(`parsed only ${rows.length} entries from src/labels.ts — the pattern is wrong, not the table`);
  process.exit(2);
}

const SYMBOL = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;

/**
 * Retry ACROSS PROVIDERS before calling a read a failure. The first version of
 * this audit used a bare catch and reported 14 of Base's most-traded tokens as
 * "symbol() unreadable" — every one of them a public-RPC rate limit wearing the
 * shape of a label defect. A swallowed error becomes a finding about the wrong
 * thing.
 */
async function symbolOf(addr: Address): Promise<{ ok: true; v: string } | { ok: false; err: string }> {
  let last = 'no attempt made';
  for (let a = 0; a < 6; a++) {
    try {
      return { ok: true, v: (await clients[a % clients.length].readContract({ address: addr, abi: SYMBOL, functionName: 'symbol' })) as string };
    } catch (e) {
      last = String((e as { shortMessage?: string }).shortMessage ?? (e as Error).message).slice(0, 120);
      await new Promise((r) => setTimeout(r, 250 * (a + 1)));
    }
  }
  return { ok: false, err: last };
}

let ok = 0;
let instrument = 0;
const problems: string[] = [];

for (const r of rows) {
  let code: string | undefined;
  try {
    code = await clients[0].getCode({ address: r.addr });
  } catch {
    code = undefined;
  }
  if (!code || code === '0x') {
    problems.push(`NO CODE            ${r.label.padEnd(26)} ${r.addr}`);
    continue;
  }
  if (r.cat !== 'token') {
    ok++;
    continue;
  }
  const s = await symbolOf(r.addr);
  if (!s.ok) {
    // Reported apart from real findings on purpose: this is our inability to
    // ask, not the chain's answer. Counting it as a failure would inflate the
    // problem list with our own rate limits.
    instrument++;
    console.log(`  UNRESOLVED (ours)  ${r.label.padEnd(26)} ${s.err}`);
    continue;
  }
  // The table adds human descriptors ("AERO (Aerodrome)"); the chain returns the
  // bare ticker. A prefix match is the honest comparison — an entry whose ticker
  // does not START the label is a real disagreement.
  if (!r.label.toLowerCase().startsWith(s.v.toLowerCase())) {
    problems.push(`SYMBOL MISMATCH    ${r.label.padEnd(26)} ${r.addr}  chain says "${s.v}"`);
  } else ok++;
  await new Promise((r) => setTimeout(r, 90));
}

console.log(`\n${rows.length} entries: ${ok} verified, ${problems.length} problems, ${instrument} unresolved (ours).`);
for (const p of problems) console.log(`  ${p}`);
if (instrument > 0) console.log(`\n${instrument} entries could not be READ. That is not a pass for them.`);
process.exit(problems.length > 0 ? 1 : 0);
