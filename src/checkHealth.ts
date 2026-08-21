import type { CheckStatus, ChecksPerformed } from './types.js';

/**
 * Rolling availability of each risk check, in hourly buckets.
 *
 * The `checks` field on a single response tells one caller whether the lookups
 * behind their answer ran. It cannot tell us that a check is broken for
 * everybody — that only exists across responses. This module keeps the
 * across-responses view, so a check that goes dark reads as an incident with a
 * duration rather than as a footnote on requests nobody re-reads.
 *
 * Hourly, because the failure this exists to catch has that shape. On
 * 2026-08-20 base.blockscout.com answered HTTP 500 at 22:04 and HTTP 200 at
 * 22:20; `first_interaction` has no other source unless ETHERSCAN_API_KEY is
 * set, so it could not fire at all in between. Averaged over a day that is a
 * rounding error; per hour it is a check that was completely dark.
 *
 * Cost: the buckets are bounded by time, not by traffic (RETAIN_HOURS x 3
 * checks x 5 counters in memory), and they persist as rollup lines on the
 * existing ledger rather than one monitoring event per call — a 256MB machine
 * with a single append-only file on a small volume cannot afford per-call
 * telemetry that grows with success.
 */

/** The checks whose availability is tracked: the `CheckStatus`-valued fields of `ChecksPerformed`. */
export const CHECK_NAMES = ['contract_verification', 'first_interaction', 'drainer_blacklist'] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

/**
 * Fails to compile if a `CheckStatus` field is added to `ChecksPerformed` without
 * being listed above — a new risk check must not be monitored by accident-of-omission.
 */
type StatusValuedKeys = {
  [K in keyof ChecksPerformed]: ChecksPerformed[K] extends CheckStatus ? K : never;
}[keyof ChecksPerformed];
const _everyCheckIsTracked: Record<StatusValuedKeys, CheckName> = {
  contract_verification: 'contract_verification',
  first_interaction: 'first_interaction',
  drainer_blacklist: 'drainer_blacklist',
};
void _everyCheckIsTracked;

const STATUSES = ['ok', 'partial', 'unavailable', 'inconclusive', 'not_applicable'] as const;

type Counts = Record<CheckStatus, number>;

interface HourBucket {
  counts: Record<CheckName, Counts>;
  /** Counts have changed since the last ledger append. */
  dirty: boolean;
  /** The payload as last appended, so an unchanged bucket is never rewritten. */
  writtenPayload: string | null;
  /** Totals at the last append, so the write policy can see what grew. */
  writtenDegraded: number;
  writtenResponses: number;
}

/** One hour of counts as it appears on the ledger. Zero counters are omitted to keep the line short. */
export interface CheckHealthEvent {
  t: string;
  e: 'checks';
  /** `YYYY-MM-DDTHH`, always UTC. */
  hour: string;
  counts: Record<string, Partial<Record<CheckStatus, number>>>;
}

export interface CheckAvailability extends Counts {
  /** Every response where this check had something to look at (everything but `not_applicable`). */
  attempts: number;
  /** `unavailable / attempts`; 0 when there were no attempts, which is not the same as healthy. */
  unavailable_rate: number;
  /** Longest run of consecutive hours in which every attempt came back `unavailable`. */
  dark_hours: number;
  /** Start of the most recent hour in which the check was `unavailable` at least once. */
  last_unavailable_at: string | null;
}

export interface CheckHealthSnapshot {
  window_hours: number;
  /** Hours in the window that saw any traffic at all. A quiet server is not a healthy one. */
  observed_hours: number;
  checks: Record<CheckName, CheckAvailability>;
}

const HOUR_MS = 60 * 60 * 1000;
/** Eight days: enough to answer a 7-day question with a full window. */
const RETAIN_HOURS = 24 * 8;
/**
 * Append an in-progress hour once this many further responses have accumulated,
 * so a deploy or crash costs a bounded slice of the denominator rather than the
 * whole open hour. Closed hours and fresh degradation are written regardless.
 */
const RESPONSES_BETWEEN_WRITES = 50;

const buckets = new Map<string, HourBucket>();
/** Nothing can fall out of retention within one hour, so pruning more often is wasted work per call. */
let lastPrunedHour = '';

function hourKey(at: Date): string {
  return at.toISOString().slice(0, 13);
}

function hourTime(hour: string): number {
  return Date.parse(`${hour}:00:00.000Z`);
}

function emptyCounts(): Counts {
  return { ok: 0, partial: 0, unavailable: 0, inconclusive: 0, not_applicable: 0 };
}

function prune(nowMs: number): void {
  const nowHour = new Date(nowMs).toISOString().slice(0, 13);
  if (nowHour === lastPrunedHour) return;
  lastPrunedHour = nowHour;
  const cutoff = nowMs - RETAIN_HOURS * HOUR_MS;
  for (const hour of buckets.keys()) {
    if (hourTime(hour) < cutoff) buckets.delete(hour);
  }
}

function bucketFor(hour: string): HourBucket {
  let bucket = buckets.get(hour);
  if (!bucket) {
    bucket = {
      counts: {
        contract_verification: emptyCounts(),
        first_interaction: emptyCounts(),
        drainer_blacklist: emptyCounts(),
      },
      dirty: false,
      writtenPayload: null,
      writtenDegraded: 0,
      writtenResponses: 0,
    };
    buckets.set(hour, bucket);
  }
  return bucket;
}

/** Attempts = every response where the check had work to do. `not_applicable` had none. */
function attemptsOf(counts: Counts): number {
  return counts.ok + counts.partial + counts.unavailable + counts.inconclusive;
}

function totalAcross(bucket: HourBucket, of: (c: Counts) => number): number {
  return CHECK_NAMES.reduce((sum, name) => sum + of(bucket.counts[name]), 0);
}

/**
 * Responses recorded in this hour. Every response increments exactly one status
 * for every check, so each check's own total is the response count; the max is
 * taken so a replayed line that lost a check still reports the true volume
 * rather than a fraction of it.
 */
function responsesOf(bucket: HourBucket): number {
  return Math.max(
    ...CHECK_NAMES.map((name) => STATUSES.reduce((sum, status) => sum + bucket.counts[name][status], 0)),
  );
}

/** Record the outcome of one explained transaction. */
export function recordChecks(checks: ChecksPerformed, at: Date = new Date()): void {
  prune(at.getTime());
  const bucket = bucketFor(hourKey(at));
  for (const name of CHECK_NAMES) {
    const counts = bucket.counts[name];
    // A status outside the known set would otherwise add a key nothing reads,
    // quietly deducting that response from every rate computed from these counts.
    if (typeof counts[checks[name]] === 'number') counts[checks[name]]++;
  }
  bucket.dirty = true;
}

function payloadFor(bucket: HourBucket): Record<string, Partial<Record<CheckStatus, number>>> {
  const counts: Record<string, Partial<Record<CheckStatus, number>>> = {};
  for (const name of CHECK_NAMES) {
    const nonZero: Partial<Record<CheckStatus, number>> = {};
    for (const status of STATUSES) {
      const n = bucket.counts[name][status];
      if (n > 0) nonZero[status] = n;
    }
    if (Object.keys(nonZero).length > 0) counts[name] = nonZero;
  }
  return counts;
}

/**
 * Rollup lines that are due to be persisted, marking them as written.
 *
 * A closed hour is written once, so a healthy day costs 24 lines however much
 * traffic it carried. An open hour is written the moment its degraded total
 * grows — an outage reaches the disk within one flush interval rather than
 * waiting for the hour to end — and again every RESPONSES_BETWEEN_WRITES
 * responses. An unchanged bucket is never rewritten.
 *
 * Replay is last-write-wins per hour, so a re-written hour supersedes its own
 * earlier lines and duplicates cost bytes, never correctness.
 */
export function takeCheckHealthEvents(now: Date = new Date()): CheckHealthEvent[] {
  const nowHour = hourKey(now);
  const due: CheckHealthEvent[] = [];
  for (const [hour, bucket] of buckets) {
    if (!bucket.dirty) continue;
    const closed = hour < nowHour;
    const degraded = totalAcross(bucket, (c) => c.unavailable + c.partial);
    const responses = responsesOf(bucket);
    const timely =
      closed || degraded > bucket.writtenDegraded || responses - bucket.writtenResponses >= RESPONSES_BETWEEN_WRITES;
    if (!timely) continue;

    const counts = payloadFor(bucket);
    const payload = JSON.stringify(counts);
    if (payload !== bucket.writtenPayload) {
      due.push({ t: now.toISOString(), e: 'checks', hour, counts });
      bucket.writtenPayload = payload;
      bucket.writtenDegraded = degraded;
      bucket.writtenResponses = responses;
    }
    // A closed hour can no longer change, so it is done either way.
    if (closed) bucket.dirty = false;
  }
  return due;
}

/** Replay one rollup line. Last write wins: a later line for an hour is that hour's final word. */
export function absorbCheckHealthEvent(ev: CheckHealthEvent, now: Date = new Date()): void {
  if (typeof ev.hour !== 'string' || Number.isNaN(hourTime(ev.hour))) return;
  prune(now.getTime());
  // Older than retention: the line is history we deliberately do not keep.
  if (hourTime(ev.hour) < now.getTime() - RETAIN_HOURS * HOUR_MS) return;
  const bucket = bucketFor(ev.hour);
  for (const name of CHECK_NAMES) {
    const counts = emptyCounts();
    const recorded = ev.counts?.[name];
    if (recorded) {
      for (const status of STATUSES) {
        const n = recorded[status];
        if (typeof n === 'number' && Number.isFinite(n) && n > 0) counts[status] = n;
      }
    }
    bucket.counts[name] = counts;
  }
  // Replayed state is already on disk; only new activity makes it dirty again.
  bucket.dirty = false;
  bucket.writtenPayload = JSON.stringify(payloadFor(bucket));
  bucket.writtenDegraded = totalAcross(bucket, (c) => c.unavailable + c.partial);
  bucket.writtenResponses = responsesOf(bucket);
}

/**
 * Availability over the last `hours` hours, ending with the current (partial) hour.
 *
 * Deliberately not an hour-by-hour series: the whole point is a number a human or
 * a report can act on, and the ledger keeps the per-hour detail for anyone who
 * needs to reconstruct a specific window.
 */
export function checkHealthSnapshot(hours = 24, now: Date = new Date()): CheckHealthSnapshot {
  const window = Math.max(1, Math.floor(hours));
  const end = hourTime(hourKey(now));
  const totals = {} as Record<CheckName, CheckAvailability>;
  const runs = {} as Record<CheckName, { current: number; longest: number }>;
  for (const name of CHECK_NAMES) {
    totals[name] = {
      ...emptyCounts(),
      attempts: 0,
      unavailable_rate: 0,
      dark_hours: 0,
      last_unavailable_at: null,
    };
    runs[name] = { current: 0, longest: 0 };
  }

  let observed = 0;
  for (let i = window - 1; i >= 0; i--) {
    const hour = new Date(end - i * HOUR_MS).toISOString().slice(0, 13);
    const bucket = buckets.get(hour);
    if (bucket && totalAcross(bucket, attemptsOf) > 0) observed++;
    for (const name of CHECK_NAMES) {
      const counts = bucket?.counts[name] ?? emptyCounts();
      const total = totals[name];
      for (const status of STATUSES) total[status] += counts[status];
      const attempts = attemptsOf(counts);
      if (counts.unavailable > 0) total.last_unavailable_at = `${hour}:00:00.000Z`;
      // Dark = the check had work to do this hour and not one attempt got an
      // answer. An hour with no attempts neither starts nor breaks a run: it is
      // absence of evidence, and treating it as recovery would end an outage on
      // the strength of nobody having called.
      const run = runs[name];
      if (attempts === 0) continue;
      if (counts.unavailable === attempts) {
        run.current++;
        if (run.current > run.longest) run.longest = run.current;
      } else {
        run.current = 0;
      }
    }
  }

  for (const name of CHECK_NAMES) {
    const total = totals[name];
    total.attempts = attemptsOf(total);
    total.unavailable_rate = total.attempts > 0 ? Number((total.unavailable / total.attempts).toFixed(4)) : 0;
    total.dark_hours = runs[name].longest;
  }

  return { window_hours: window, observed_hours: observed, checks: totals };
}

/** Test seam: forget everything. Production never calls this. */
export function resetCheckHealth(): void {
  buckets.clear();
  lastPrunedHour = '';
}
