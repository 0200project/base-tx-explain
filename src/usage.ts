import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Append-only usage ledger. One JSONL file on disk (a Fly volume in
 * production, ./data locally) so demand and revenue signals survive
 * restarts and deploys. Aggregates are rebuilt from the file on boot and
 * kept in memory; every event is appended synchronously — at $0.02/call
 * the write volume is trivial and losing billing events to a crash is
 * worse than the sync cost.
 */

export type UsageEvent =
  | { t: string; e: 'call'; charge: boolean; paid?: boolean; client: string; ok?: boolean }
  | { t: string; e: 'settled'; client: string; amount_usd: number; payer?: string; tx?: string };

interface DayAgg {
  calls: number;
  free: number;
  /** 402 challenges served: a client hit the paywall without payment attached. */
  wall_hits: number;
  /** Calls that arrived carrying an x402 payment (settlement is tracked separately). */
  paid_calls: number;
  settlements: number;
  revenue_usd: number;
  clients: Set<string>;
}

const dataDir = process.env.DATA_DIR ?? './data';
const ledgerPath = join(dataDir, 'events.jsonl');

const days = new Map<string, DayAgg>();
const lifetime = { calls: 0, free: 0, wall_hits: 0, paid_calls: 0, settlements: 0, revenue_usd: 0 };
const lifetimeClients = new Set<string>();
let firstEventAt: string | null = null;
let ledgerReady = false;

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

function aggFor(day: string): DayAgg {
  let agg = days.get(day);
  if (!agg) {
    agg = { calls: 0, free: 0, wall_hits: 0, paid_calls: 0, settlements: 0, revenue_usd: 0, clients: new Set() };
    days.set(day, agg);
  }
  return agg;
}

function absorb(ev: UsageEvent): void {
  if (!firstEventAt || ev.t < firstEventAt) firstEventAt = ev.t;
  const agg = aggFor(dayOf(ev.t));
  if (ev.e === 'call') {
    agg.calls++;
    lifetime.calls++;
    if (ev.charge && ev.paid) {
      agg.paid_calls++;
      lifetime.paid_calls++;
    } else if (ev.charge) {
      agg.wall_hits++;
      lifetime.wall_hits++;
    } else {
      agg.free++;
      lifetime.free++;
    }
    agg.clients.add(ev.client);
    lifetimeClients.add(ev.client);
  } else {
    agg.settlements++;
    lifetime.settlements++;
    agg.revenue_usd += ev.amount_usd;
    lifetime.revenue_usd += ev.amount_usd;
  }
}

/** Replay the ledger into memory. Corrupt trailing lines (crash mid-write) are skipped. */
export function initUsageLedger(): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    if (existsSync(ledgerPath)) {
      for (const line of readFileSync(ledgerPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          absorb(JSON.parse(line) as UsageEvent);
        } catch {
          /* torn write; ignore the line */
        }
      }
    }
    ledgerReady = true;
    console.log(`usage ledger: ${ledgerPath} (${lifetime.calls} calls, $${lifetime.revenue_usd.toFixed(2)} settled on record)`);
  } catch (err) {
    // A broken ledger must never take the payment path down with it.
    console.error('usage ledger unavailable, continuing without persistence:', err);
  }
}

export function recordEvent(ev: UsageEvent): void {
  absorb(ev);
  if (!ledgerReady) return;
  try {
    appendFileSync(ledgerPath, JSON.stringify(ev) + '\n');
  } catch (err) {
    ledgerReady = false;
    console.error('usage ledger write failed, disabling persistence:', err);
  }
}

/** Aggregates for /stats: lifetime totals plus a recent daily series. */
export function usageSnapshot(daysBack = 30): Record<string, unknown> {
  const series: Array<Record<string, unknown>> = [];
  const today = new Date();
  for (let i = daysBack - 1; i >= 0; i--) {
    const day = new Date(today.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    const agg = days.get(day);
    series.push({
      day,
      calls: agg?.calls ?? 0,
      free: agg?.free ?? 0,
      wall_hits: agg?.wall_hits ?? 0,
      paid_calls: agg?.paid_calls ?? 0,
      settlements: agg?.settlements ?? 0,
      revenue_usd: Number((agg?.revenue_usd ?? 0).toFixed(6)),
      unique_clients: agg?.clients.size ?? 0,
    });
  }
  return {
    persisted: ledgerReady,
    first_event_at: firstEventAt,
    lifetime: {
      ...lifetime,
      revenue_usd: Number(lifetime.revenue_usd.toFixed(6)),
      unique_clients: lifetimeClients.size,
    },
    daily: series,
  };
}
