/**
 * Do we actually decode unverified contracts better than the free alternative?
 *
 * The segment research named this "the only defensible wedge I could produce
 * empirically" and then, correctly, refused to call it a finding: the gap in
 * Blockscout was confirmed at n=1, and nobody checked whether WE close it. If
 * we draw on the same sources, there is no wedge and it must not be sold.
 *
 * This measures it. For each sampled Base transaction whose `to` contract is
 * unverified, compare what Blockscout can say against what we say.
 *
 *   npx tsx scripts/unverified-gap.ts [sample-size]
 *
 * Reads INTERNAL_MARKER so the sample does not land in the ledger looking like
 * a stranger — the mistake paid-call.ts made.
 */
import { readFileSync } from 'node:fs';

const BS = 'https://base.blockscout.com/api/v2';
const SERVER = process.env.PUBLIC_URL ?? 'https://base-tx-explain.fly.dev';
const WANT = Number.parseInt(process.argv[2] ?? '12', 10);

function marker(): string {
  if (process.env.INTERNAL_MARKER) return process.env.INTERNAL_MARKER;
  try {
    return readFileSync(new URL('../.internal-marker', import.meta.url), 'utf8').trim();
  } catch {
    return '';
  }
}

const MARKER = marker();
if (!MARKER) console.warn('WARNING: no INTERNAL_MARKER — this sample will count as external traffic.\n');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function j<T>(url: string, headers: Record<string, string> = {}): Promise<T | null> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface BsTx {
  hash: string;
  to: { hash: string; is_contract: boolean; is_verified: boolean | null } | null;
  decoded_input: { method_call?: string; method_id?: string } | null;
  method: string | null;
  status: string | null;
}

/** Recent transactions whose target contract is UNVERIFIED. */
async function findUnverified(want: number): Promise<BsTx[]> {
  const out: BsTx[] = [];
  const seen = new Set<string>();
  let next = '';
  for (let page = 0; page < 8 && out.length < want; page++) {
    const body = await j<{ items: BsTx[]; next_page_params: Record<string, unknown> | null }>(
      `${BS}/transactions?filter=validated${next}`,
    );
    if (!body?.items) break;
    for (const t of body.items) {
      if (out.length >= want) break;
      if (!t.to?.is_contract) continue;
      if (t.to.is_verified === true) continue; // verified: not our question
      if (seen.has(t.hash)) continue;
      seen.add(t.hash);
      out.push(t);
    }
    const p = body.next_page_params;
    if (!p) break;
    next = '&' + new URLSearchParams(p as Record<string, string>).toString();
    await sleep(250);
  }
  return out;
}

interface Ours {
  summary?: string;
  classification?: string;
  assets_moved?: unknown[];
  counterparties?: unknown[];
  risk_flags?: Array<{ code?: string }>;
  action?: string;
  method?: string;
  [k: string]: unknown;
}

/** POST /explain — the REST face. A GET there is a 405 by design. */
async function ours(hash: string): Promise<Ours | null> {
  try {
    const res = await fetch(`${SERVER}/explain`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(MARKER ? { 'x-btx-internal': MARKER } : {}),
      },
      body: JSON.stringify({ tx_hash: hash }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
      // A paywall or an exhausted free tier is not a decode failure, and
      // silently scoring it as one would understate our own capability.
      console.log(`   [${res.status} ${body.code ?? ''}] ${String(body.error ?? '').slice(0, 80)}`);
      return null;
    }
    return (await res.json()) as Ours;
  } catch {
    return null;
  }
}

/** Any human-readable function name anywhere in our payload. */
function methodNamed(o: Ours | null): string | null {
  if (!o) return null;
  const blob = JSON.stringify(o);
  // A named call looks like `someFunction(` — a bare selector does not.
  const m = blob.match(/"(?:method|action|function|method_call)"\s*:\s*"([^"]{2,80})"/);
  if (m?.[1] && !/^0x[0-9a-f]{8}$/i.test(m[1])) return m[1];
  return null;
}

const rows: Array<Record<string, unknown>> = [];

const sample = await findUnverified(WANT);
console.log(`Sampled ${sample.length} Base transactions to UNVERIFIED contracts.\n`);

for (const t of sample) {
  const bsNamed = t.decoded_input?.method_call ?? null;
  const o = await ours(t.hash);
  const oursNamed = methodNamed(o);

  rows.push({
    hash: t.hash,
    contract: t.to?.hash,
    bs_decoded: bsNamed,
    bs_method: t.method ?? null,
    ours_method: oursNamed,
    ours_summary: o?.summary ?? null,
    ours_assets: Array.isArray(o?.assets_moved) ? o!.assets_moved!.length : null,
    ours_parties: Array.isArray(o?.counterparties) ? o!.counterparties!.length : null,
    ours_flags: Array.isArray(o?.risk_flags) ? o!.risk_flags!.map((f) => f.code).join(',') : null,
    ours_ok: o !== null,
  });

  console.log(`${t.hash.slice(0, 12)}…  contract ${String(t.to?.hash).slice(0, 10)}…`);
  console.log(`   blockscout decoded_input : ${bsNamed ?? 'NULL' + (t.method ? ` (bare: ${t.method})` : '')}`);
  console.log(`   ours   method            : ${oursNamed ?? '—'}`);
  console.log(`   ours   summary           : ${(o?.summary ?? '—').toString().slice(0, 110)}`);
  console.log(`   ours   assets/parties    : ${rows.at(-1)!.ours_assets}/${rows.at(-1)!.ours_parties}   flags: ${rows.at(-1)!.ours_flags || '—'}`);
  console.log();
  await sleep(400);
}

const served = rows.filter((r) => r.ours_ok);
const bsBlank = rows.filter((r) => !r.bs_decoded);
const weNamed = bsBlank.filter((r) => r.ours_method);
const weAddedAssets = bsBlank.filter((r) => (r.ours_assets as number) > 0);
const weSummarised = bsBlank.filter((r) => r.ours_summary);

console.log('='.repeat(72));
console.log(`sampled                                  ${rows.length}`);
console.log(`our endpoint answered                    ${served.length}/${rows.length}`);
console.log(`blockscout decoded_input was NULL        ${bsBlank.length}/${rows.length}`);
console.log(`  ...of those, WE named the function     ${weNamed.length}/${bsBlank.length}`);
console.log(`  ...of those, WE listed assets moved    ${weAddedAssets.length}/${bsBlank.length}`);
console.log(`  ...of those, WE produced a summary     ${weSummarised.length}/${bsBlank.length}`);
console.log('='.repeat(72));
console.log('\nVERDICT INPUT — the wedge is real only if the middle number is high.');
console.log(JSON.stringify(rows, null, 1));
