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
 * Calls the decoder in-process, so it neither consumes the free tier nor lands
 * in the ledger looking like a stranger.
 */
import { explainTransaction } from '../src/explain.js';

const BS = 'https://base.blockscout.com/api/v2';
const WANT = Number.parseInt(process.argv[2] ?? '12', 10);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Blockscout rate-limits an unauthenticated caller, and a silent null here
 * produced a run that reported "sampled 0" as though no unverified contracts
 * exist on Base. An empty sample and a throttled sample must not look alike —
 * the same silence-reads-as-a-result failure this codebase keeps finding.
 */
async function j<T>(url: string, headers: Record<string, string> = {}): Promise<T | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
      if (res.ok) return (await res.json()) as T;
      if (res.status === 429 || res.status >= 500) {
        const wait = 1500 * 2 ** attempt;
        console.log(`   [blockscout ${res.status}] backing off ${wait}ms`);
        await sleep(wait);
        continue;
      }
      return null;
    } catch {
      await sleep(1500 * 2 ** attempt);
    }
  }
  console.log('   [blockscout] gave up after 4 attempts');
  return null;
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
      // No `filter=validated`: Blockscout 500s on it intermittently, which cost
      // a run. Plain /transactions is stable; filter client-side instead.
      `${BS}/transactions${next ? `?${next.slice(1)}` : ''}`,
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

/**
 * Call the decoder IN-PROCESS rather than over HTTP.
 *
 * The first attempt went through `POST /explain` and scored 0 of 12 — not
 * because the decoder failed but because this IP had exhausted its own free
 * tier, so every call came back paywalled. A run that measures our billing
 * instead of our decoding, and reports the result as a capability finding, is
 * worse than no run: it produced a confident "we never name the function"
 * that happened to point the same way as the truth, for entirely the wrong
 * reason.
 *
 * The question is about the decoder, so ask the decoder.
 */
async function ours(hash: string): Promise<Ours | null> {
  try {
    return (await explainTransaction(hash)) as unknown as Ours;
  } catch (err) {
    console.log(`   [decode failed] ${err instanceof Error ? err.message.slice(0, 90) : 'unknown'}`);
    return null;
  }
}

/**
 * The function name we resolved, or null if we only had a bare selector.
 *
 * Read out of the summary rather than a field, because that is where it
 * actually lives. The decoder emits one of two shapes:
 *
 *   "... called contract 0x… (function: updatePrice)"
 *   "... called contract 0x… (unrecognized function, selector 0x7b84f330)"
 *
 * An earlier version scanned the whole payload for a `method`-ish key. No such
 * key exists, so it returned null unconditionally and would have scored a
 * perfect decoder as useless. It agreed with the truth by accident, which is
 * the most dangerous way for a measurement to be right.
 */
function methodNamed(o: Ours | null): string | null {
  const summary = typeof o?.summary === 'string' ? o.summary : '';
  const named = summary.match(/\(function:\s*([^)]{1,80})\)/);
  return named?.[1]?.trim() ?? null;
}

const rows: Array<Record<string, unknown>> = [];

const sample = await findUnverified(WANT);
if (sample.length === 0) {
  console.error(
    '\nNO SAMPLE. This is a failed run, not a finding — Blockscout returned nothing,\n' +
      'most likely rate limiting. Do not read it as "no unverified contracts exist".\n',
  );
  process.exit(2);
}
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
console.log(`our decoder answered                     ${served.length}/${rows.length}`);
console.log(`blockscout decoded_input was NULL        ${bsBlank.length}/${rows.length}`);
console.log(`  ...of those, WE named the function     ${weNamed.length}/${bsBlank.length}`);
console.log(`  ...of those, WE listed assets moved    ${weAddedAssets.length}/${bsBlank.length}`);
console.log(`  ...of those, WE produced a summary     ${weSummarised.length}/${bsBlank.length}`);
console.log('='.repeat(72));
console.log('\nVERDICT INPUT — the wedge is real only if the middle number is high.');
console.log(JSON.stringify(rows, null, 1));
