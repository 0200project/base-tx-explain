/**
 * Validation harness: sample recent Base-mainnet transactions, run the
 * explainer on each, and grade the output. Ship gate: >=90% of sampled txs
 * decode cleanly (a specific action_type, not partial) and the rest fail
 * gracefully (valid JSON with a summary, never a crash).
 *
 * Usage: npm run validate [-- --count 100]
 */
import type { Hex } from 'viem';
import { explainTransaction } from '../src/explain.js';
import { client } from '../src/rpc.js';

const COUNT = (() => {
  const i = process.argv.indexOf('--count');
  return i > -1 ? Number.parseInt(process.argv[i + 1] ?? '100', 10) : 100;
})();
const CONCURRENCY = 3;

interface Graded {
  hash: string;
  grade: 'clean' | 'partial' | 'graceful_error' | 'crash';
  action?: string;
  summary?: string;
  note?: string;
  ms: number;
}

async function sampleTxHashes(count: number): Promise<Hex[]> {
  const latest = await client.getBlockNumber();
  const hashes: Hex[] = [];
  const seenTargets = new Set<string>();
  // Spread across ~40 blocks over the last ~2 hours for a diverse mix,
  // preferring transactions to distinct target contracts.
  for (let i = 0; hashes.length < count && i < 60; i++) {
    const blockNumber = latest - BigInt(i * 60);
    try {
      const block = await client.getBlock({ blockNumber, includeTransactions: true });
      let taken = 0;
      for (const tx of block.transactions) {
        if (hashes.length >= count || taken >= 4) break;
        const target = tx.to?.toLowerCase() ?? 'deploy';
        if (seenTargets.has(target)) continue;
        seenTargets.add(target);
        hashes.push(tx.hash);
        taken++;
      }
    } catch {
      // skip unfetchable block
    }
  }
  return hashes;
}

async function gradeOne(hash: Hex): Promise<Graded> {
  const start = Date.now();
  try {
    const r = await explainTransaction(hash);
    const ms = Date.now() - start;
    if (!r.summary || !r.action_type) {
      return { hash, grade: 'graceful_error', note: 'missing summary/action', ms };
    }
    if (r.action_type === 'unknown' || r.partial) {
      return { hash, grade: 'partial', action: r.action_type, summary: r.summary, ms };
    }
    return { hash, grade: 'clean', action: r.action_type, summary: r.summary, ms };
  } catch (err) {
    const ms = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    // ExplainError with a clear message is a graceful failure by design.
    if (err && typeof err === 'object' && 'code' in err) {
      return { hash, grade: 'graceful_error', note: message, ms };
    }
    return { hash, grade: 'crash', note: message, ms };
  }
}

async function main() {
  console.log(`Sampling ${COUNT} recent Base mainnet transactions...`);
  const hashes = await sampleTxHashes(COUNT);
  console.log(`Sampled ${hashes.length}. Explaining with concurrency ${CONCURRENCY}...\n`);

  const results: Graded[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (cursor < hashes.length) {
        const hash = hashes[cursor++];
        if (!hash) break;
        const graded = await gradeOne(hash);
        results.push(graded);
        const mark =
          graded.grade === 'clean' ? '.' : graded.grade === 'partial' ? 'p' : graded.grade === 'graceful_error' ? 'e' : 'X';
        process.stdout.write(mark);
      }
    }),
  );
  console.log('\n');

  const byGrade = new Map<string, Graded[]>();
  const byAction = new Map<string, number>();
  for (const r of results) {
    byGrade.set(r.grade, [...(byGrade.get(r.grade) ?? []), r]);
    if (r.action) byAction.set(r.action, (byAction.get(r.action) ?? 0) + 1);
  }

  const clean = byGrade.get('clean')?.length ?? 0;
  const partial = byGrade.get('partial')?.length ?? 0;
  const graceful = byGrade.get('graceful_error')?.length ?? 0;
  const crash = byGrade.get('crash')?.length ?? 0;
  const total = results.length;
  const avgMs = Math.round(results.reduce((s, r) => s + r.ms, 0) / Math.max(1, total));

  console.log('=== ACTION TYPE DISTRIBUTION ===');
  for (const [action, n] of [...byAction.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${action.padEnd(28)} ${n}`);
  }
  console.log('\n=== GRADES ===');
  console.log(`  clean            ${clean} (${((clean / total) * 100).toFixed(1)}%)`);
  console.log(`  partial          ${partial}`);
  console.log(`  graceful_error   ${graceful}`);
  console.log(`  crash            ${crash}`);
  console.log(`  avg latency      ${avgMs}ms`);

  console.log('\n=== SAMPLE SUMMARIES (one per action type) ===');
  const shown = new Set<string>();
  for (const r of results) {
    if (r.grade !== 'clean' || !r.action || shown.has(r.action)) continue;
    shown.add(r.action);
    console.log(`  [${r.action}] ${r.summary}`);
    console.log(`     ${r.hash}`);
  }

  if (partial > 0) {
    console.log('\n=== PARTIALS ===');
    for (const r of byGrade.get('partial') ?? []) {
      console.log(`  [${r.action}] ${r.hash}`);
      console.log(`     ${r.summary}`);
    }
  }
  if (graceful > 0) {
    console.log('\n=== GRACEFUL ERRORS ===');
    for (const r of byGrade.get('graceful_error') ?? []) {
      console.log(`  ${r.hash}: ${(r.note ?? '').slice(0, 160)}`);
    }
  }
  if (crash > 0) {
    console.log('\n=== CRASHES (must be zero before shipping) ===');
    for (const r of byGrade.get('crash') ?? []) console.log(`  ${r.hash}: ${r.note}`);
  }

  const gate = clean / total >= 0.9 && crash === 0;
  console.log(`\nSHIP GATE (>=90% clean, 0 crashes): ${gate ? 'PASS' : 'FAIL'}`);
  process.exit(gate ? 0 : 1);
}

main();
