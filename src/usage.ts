import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { absorbCheckHealthEvent, takeCheckHealthEvents, type CheckHealthEvent } from './checkHealth.js';

/**
 * Append-only usage ledger. One JSONL file on disk (a Fly volume in
 * production, ./data locally) so demand and revenue signals survive
 * restarts and deploys. Aggregates are rebuilt from the file on boot and
 * kept in memory; every event is appended synchronously — at $0.02/call
 * the write volume is trivial and losing billing events to a crash is
 * worse than the sync cost.
 */

export type UsageEvent =
  | { t: string; e: 'call'; charge: boolean; paid?: boolean; pass?: boolean; client: string; ok?: boolean }
  | { t: string; e: 'settled'; client: string; amount_usd: number; payer?: string; tx?: string };

/**
 * Everything the ledger carries. Risk-check availability rides the same file
 * rather than a second store: one machine, one volume, one writer, and a
 * monitoring signal that needs its own database is a monitoring signal this
 * budget cannot keep.
 */
export type LedgerEvent = UsageEvent | CheckHealthEvent;

interface DayAgg {
  calls: number;
  free: number;
  /** 402 challenges served: a client hit the paywall without payment attached. */
  wall_hits: number;
  /** Calls covered by a purchased pass. */
  pass_calls: number;
  /**
   * Calls that ARRIVED carrying an x402 payment payload. This is payment
   * attempted, not payment succeeded: the flag is set from the presence of the
   * payload before any verification, and settlement is tracked separately in
   * `settlements`. A high count here with zero settlements means payments were
   * offered and did not complete, NOT that calls were served without paying.
   * Exposed as `payment_attempted` in snapshots for exactly that reason.
   */
  paid_calls: number;
  settlements: number;
  revenue_usd: number;
  clients: Set<string>;
}

const dataDir = process.env.DATA_DIR ?? './data';
const ledgerPath = join(dataDir, 'events.jsonl');

const days = new Map<string, DayAgg>();
const lifetime = { calls: 0, free: 0, wall_hits: 0, paid_calls: 0, pass_calls: 0, settlements: 0, revenue_usd: 0 };
const lifetimeClients = new Set<string>();
let firstEventAt: string | null = null;
let ledgerReady = false;

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

function aggFor(day: string): DayAgg {
  let agg = days.get(day);
  if (!agg) {
    agg = { calls: 0, free: 0, wall_hits: 0, paid_calls: 0, pass_calls: 0, settlements: 0, revenue_usd: 0, clients: new Set() };
    days.set(day, agg);
  }
  return agg;
}

function absorb(ev: LedgerEvent): void {
  // Check-health rollups are not demand events: they carry no client and must
  // not move `first_event_at`, which means "when did anyone first call this".
  if (ev.e === 'checks') {
    absorbCheckHealthEvent(ev);
    return;
  }
  if (!firstEventAt || ev.t < firstEventAt) firstEventAt = ev.t;
  const agg = aggFor(dayOf(ev.t));
  // Every type is matched explicitly. A line this replay does not recognise —
  // a rollback to a build that predates an event type, say — must be ignored,
  // not fall through a trailing `else` and be counted as a settlement.
  if (ev.e === 'call') {
    agg.calls++;
    lifetime.calls++;
    if (ev.pass) {
      agg.pass_calls++;
      lifetime.pass_calls++;
    } else if (ev.charge && ev.paid) {
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
  } else if (ev.e === 'settled') {
    agg.settlements++;
    lifetime.settlements++;
    agg.revenue_usd += ev.amount_usd;
    lifetime.revenue_usd += ev.amount_usd;
  }
}

/** How often to look for check-health buckets due to be persisted. */
const CHECK_HEALTH_FLUSH_MS = 60_000;
let checkHealthTimer: NodeJS.Timeout | null = null;

/** Replay the ledger into memory. Corrupt trailing lines (crash mid-write) are skipped. */
export function initUsageLedger(): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    if (existsSync(ledgerPath)) {
      for (const line of readFileSync(ledgerPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          absorb(JSON.parse(line) as LedgerEvent);
        } catch {
          /* torn write; ignore the line */
        }
      }
    }
    ledgerReady = true;
    // Unref'd: a monitoring flush must never be the reason the process stays alive.
    checkHealthTimer ??= setInterval(flushCheckHealth, CHECK_HEALTH_FLUSH_MS).unref();
    console.log(`usage ledger: ${ledgerPath} (${lifetime.calls} calls, $${lifetime.revenue_usd.toFixed(2)} settled on record)`);
  } catch (err) {
    // A broken ledger must never take the payment path down with it.
    console.error('usage ledger unavailable, continuing without persistence:', err);
  }
}

function appendToLedger(ev: LedgerEvent): void {
  if (!ledgerReady) return;
  try {
    appendFileSync(ledgerPath, JSON.stringify(ev) + '\n');
  } catch (err) {
    ledgerReady = false;
    console.error('usage ledger write failed, disabling persistence:', err);
  }
}

export function recordEvent(ev: UsageEvent): void {
  absorb(ev);
  appendToLedger(ev);
}

/**
 * Persist any risk-check rollups the write policy says are due.
 *
 * Bails before taking them when the ledger is unwritable, so the buckets stay
 * dirty and land on a later flush instead of being marked written into a file
 * that rejected them.
 */
export function flushCheckHealth(): void {
  if (!ledgerReady) return;
  for (const ev of takeCheckHealthEvents()) appendToLedger(ev);
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
      payment_attempted: agg?.paid_calls ?? 0,
      pass_calls: agg?.pass_calls ?? 0,
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
      // `paid_calls` counts calls that ARRIVED carrying a payment payload, not
      // calls that were paid for. Sitting next to revenue_usd on a public
      // endpoint it reads as "served paid calls, booked no revenue", and two
      // separate readers drew that false alarm from it in one night. The honest
      // name is emitted alongside; the old key stays until the public status
      // page, which reads it, has been republished.
      payment_attempted: lifetime.paid_calls,
      revenue_usd: Number(lifetime.revenue_usd.toFixed(6)),
      unique_clients: lifetimeClients.size,
    },
    daily: series,
  };
}
