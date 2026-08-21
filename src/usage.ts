import { bookedNonRevenueTotal, isKnownNonRevenue, revenueNote } from './knownNonRevenue.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { absorbCheckHealthEvent, takeCheckHealthEvents, type CheckHealthEvent } from './checkHealth.js';
import { CHANNEL_CAVEAT, DIRECT, OTHER, PRE_ATTRIBUTION, knownChannels } from './channel.js';
import { isAttributed } from './attribution.js';

/**
 * Append-only usage ledger. One JSONL file on disk (a Fly volume in
 * production, ./data locally) so demand and revenue signals survive
 * restarts and deploys. Aggregates are rebuilt from the file on boot and
 * kept in memory; every event is appended synchronously — at $0.02/call
 * the write volume is trivial and losing billing events to a crash is
 * worse than the sync cost.
 */

export type UsageEvent =
  | { t: string; e: 'call'; charge: boolean; paid?: boolean; pass?: boolean; client: string; ok?: boolean; internal?: boolean; degraded?: boolean; channel?: string }
  | {
      t: string;
      e: 'settled';
      client: string;
      amount_usd: number;
      payer?: string;
      tx?: string;
      /** Ours, detected at settlement. Resolved, so never awaiting attribution. */
      self?: boolean;
      /**
       * Stable handle for this settlement (Stripe session id, or tx hash), so a
       * human can promote exactly one arrival to customer revenue. An arrival
       * with no id can never be promoted, which keeps it under-reported rather
       * than letting an unidentifiable settlement be waved through.
       */
      id?: string;
    };

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
   * Calls we gave away because payments were down, not because the caller had
   * free tier left.
   *
   * Counted apart from both `free` and `wall_hits` on purpose. Without this a
   * facilitator outage reads as demand: a caller past their free tier arrives
   * with charge=true and no payload, lands in wall_hits, and the funnel shows
   * people hitting the paywall when they were actually served for nothing. That
   * corruption points the flattering way, which is the direction we can least
   * afford given the whole question here is whether anyone wants this.
   */
  degraded_calls: number;
  /**
   * Calls we made ourselves, identified by the internal marker.
   *
   * Counted separately so the scoreboard can subtract us. An unmarked call is
   * counted as external, so this UNDERSTATES our own traffic and never
   * overstates a stranger's — the safe direction, since dismissing a real
   * stranger as internal would throw away the one signal that matters.
   */
  internal_calls: number;
  /** Distinct clients excluding ones that identified themselves as us. */
  externalClients: Set<string>;
  /** External calls per self-reported channel. Internal traffic never enters. */
  channelCalls: Map<string, number>;
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
const lifetime = { calls: 0, free: 0, wall_hits: 0, paid_calls: 0, pass_calls: 0, degraded_calls: 0, internal_calls: 0, settlements: 0, revenue_usd: 0 };

/**
 * Every settlement as it arrived, so the revenue split can be DERIVED rather
 * than accumulated.
 *
 * The counters used to be chosen in `absorb()`, at ingest. That reads the
 * attribution set at the instant the webhook lands — and in production a human
 * promotes minutes LATER, so the promotion endpoint returned `promoted: true`,
 * logged that a human had vouched, and moved nothing. The figure only caught up
 * on the next restart, when replay re-ran ingest against the persisted set,
 * making it look as though it had attributed itself.
 *
 * Deriving at read time makes ORDERING STOP EXISTING as a concept: promote,
 * un-promote, replay and restart all give the same answer by construction, and
 * there is exactly one place the split is decided so the sum invariant cannot
 * drift. Volume is one settlement lifetime, so retaining them costs nothing.
 */
const settlements: Array<{ id?: string; tx?: string; amount_usd: number; self?: boolean; at: string }> = [];
const lifetimeExternalClients = new Set<string>();
const lifetimeClients = new Set<string>();
/** External calls per channel, lifetime. */
const lifetimeChannelCalls = new Map<string, number>();
/**
 * The channel each external client was FIRST seen with, never overwritten.
 *
 * First-touch, not per-call, and the distinction decides what the number means.
 * Per-call attribution ranks channels by whichever listing sent the most
 * talkative visitor: one curious caller making forty calls would outweigh forty
 * separate arrivals. The question being asked is "which listing brought a
 * STRANGER", so a stranger counts once, against wherever they came in.
 *
 * Replay is chronological, so "first" here really is first even after a restart.
 */
const clientFirstChannel = new Map<string, string>();
let firstEventAt: string | null = null;
let ledgerReady = false;

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

function aggFor(day: string): DayAgg {
  let agg = days.get(day);
  if (!agg) {
    agg = { calls: 0, free: 0, wall_hits: 0, paid_calls: 0, pass_calls: 0, degraded_calls: 0, internal_calls: 0, settlements: 0, revenue_usd: 0, clients: new Set(), externalClients: new Set(), channelCalls: new Map() };
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
    } else if (ev.degraded) {
      // Checked BEFORE the charge branches: an outage giveaway arrives with
      // charge=true and would otherwise be counted as a paywall hit.
      agg.degraded_calls++;
      lifetime.degraded_calls++;
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
    if (ev.internal) {
      agg.internal_calls++;
      lifetime.internal_calls++;
    } else {
      agg.externalClients.add(ev.client);
      lifetimeExternalClients.add(ev.client);
      // EXTERNAL ONLY. The question this answers is "which listing brought a
      // STRANGER", so counting our own marked traffic would make our testing
      // look like acquisition — the seventh time in one day that our own
      // activity would have worn a customer's shape.
      //
      // Distinct clients matter more than calls here: one curious caller making
      // forty calls is one arrival, and ranking channels by call count would
      // promote whichever listing sent the most talkative visitor.
      // An ABSENT channel field means the event predates attribution; an
      // explicit 'direct' means a real caller supplied no ref. Collapsing them
      // would make our blind period look like a successful channel.
      const ch = ev.channel ?? PRE_ATTRIBUTION;
      agg.channelCalls.set(ch, (agg.channelCalls.get(ch) ?? 0) + 1);
      lifetimeChannelCalls.set(ch, (lifetimeChannelCalls.get(ch) ?? 0) + 1);
      // First touch wins and is never overwritten: a client who arrives via a
      // listing and later calls without the ref still belongs to that listing.
      if (!clientFirstChannel.has(ev.client)) clientFirstChannel.set(ev.client, ch);
    }
  } else if (ev.e === 'settled') {
    agg.settlements++;
    lifetime.settlements++;
    // Raw revenue still counts it: the money really did settle, and hiding
    // that would be its own dishonesty. The SPLIT is not decided here — see
    // `revenueSplit()`, which derives it at read time so a promotion arriving
    // after the settlement still moves the number.
    agg.revenue_usd += ev.amount_usd;
    lifetime.revenue_usd += ev.amount_usd;
    settlements.push({ id: ev.id, tx: ev.tx, amount_usd: ev.amount_usd, self: ev.self, at: ev.t });
  }
}

/**
 * Which listing brought each external client, first-touch.
 *
 * `arrivals` is the headline: DISTINCT external clients whose first sighting
 * carried that channel. `calls` is context only — a channel with one visitor
 * making forty calls has one arrival and forty calls, and ranking by calls
 * would promote the most talkative visitor over the most productive listing.
 *
 * Every allowlisted channel is emitted even at zero, so a listing that has
 * produced nothing is visibly nothing rather than absent. A missing row and a
 * zero row read very differently at 2am.
 *
 * The caveat rides IN the object rather than in documentation, because whoever
 * reads this at 2am reads the numbers, not the prose explaining them — the same
 * reason `risk_flags` needed `checks` beside it.
 */
function channelSnapshot(): Record<string, unknown> {
  const arrivals = new Map<string, number>();
  for (const ch of clientFirstChannel.values()) arrivals.set(ch, (arrivals.get(ch) ?? 0) + 1);

  const buckets: Record<string, { arrivals: number; calls: number }> = {};
  for (const ch of [...knownChannels(), DIRECT, OTHER, PRE_ATTRIBUTION]) {
    buckets[ch] = { arrivals: arrivals.get(ch) ?? 0, calls: lifetimeChannelCalls.get(ch) ?? 0 };
  }
  return {
    self_reported: true,
    caveat: CHANNEL_CAVEAT,
    external_clients_attributed: clientFirstChannel.size,
    buckets,
  };
}

/**
 * The three mutually exclusive revenue buckets, derived from the settlements
 * and the current attribution set.
 *
 * Pure, so it cannot go stale: whatever the attribution set says right now is
 * what the numbers say right now, regardless of what order anything happened
 * in. They sum to `revenue_usd` by construction.
 */
function revenueSplit(): {
  self: number;
  attributed: number;
  knownNonRevenue: number;
  unattributed: number;
} {
  let self = 0;
  let attributed = 0;
  let knownNonRevenue = 0;
  let unattributed = 0;
  for (const s of settlements) {
    // THREE RESOLVED STATES AND ONE PENDING ONE. `unattributed` means awaiting
    // a human, so anything a human has already ruled on belongs elsewhere —
    // otherwise the bucket never rests at zero and stops being a signal.
    //
    // Resolved: ours.
    if (s.self) self += s.amount_usd;
    // Resolved: written off, with a stated reason. Checked before the
    // promotion set so a written record outranks a click.
    else if (isKnownNonRevenue(s.tx) || isKnownNonRevenue(s.id)) knownNonRevenue += s.amount_usd;
    // Resolved: a human said it came from a customer.
    // BOTH fields, matching the write-off predicate three lines above. An x402
    // settlement is identified by `tx` and carries no `id`, so checking only
    // `id` meant the rail with the demonstrated end-to-end path — and the one
    // our first interested party has said they want — could be written off but
    // never promoted. The money would sit in `unattributed` forever and the
    // founder would read $0 on the night he is watching for a first sale.
    else if (isAttributed(s.id) || isAttributed(s.tx)) attributed += s.amount_usd;
    // PENDING: money arrived, nobody has said whose it is.
    else unattributed += s.amount_usd;
  }
  return { self, attributed, knownNonRevenue, unattributed };
}

/**
 * Which handle to paste to promote each settlement still awaiting a human.
 *
 * Widening the predicate means either `tx` or `id` works — but only one of them
 * EXISTS on any given settlement, and the operator cannot know which without
 * being told. An endpoint that is correct and unusable is one we shipped once
 * already tonight, so the answer travels with the question.
 */
function unattributedHandles(): Array<{ handle: string; amount_usd: number; at: string }> {
  const out: Array<{ handle: string; amount_usd: number; at: string }> = [];
  for (const s of settlements) {
    if (s.self) continue;
    if (isKnownNonRevenue(s.tx) || isKnownNonRevenue(s.id)) continue;
    if (isAttributed(s.id) || isAttributed(s.tx)) continue;
    const handle = s.id ?? s.tx;
    // No handle at all means no way to promote it. Reported as such rather than
    // omitted, because a settlement nobody can act on is exactly the one that
    // must not disappear from the list.
    out.push({ handle: handle ?? '(none — this settlement cannot be promoted)', amount_usd: s.amount_usd, at: s.at });
  }
  return out;
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
      degraded_calls: agg?.degraded_calls ?? 0,
      internal_calls: agg?.internal_calls ?? 0,
      external_clients: agg?.externalClients.size ?? 0,
      settlements: agg?.settlements ?? 0,
      revenue_usd: Number((agg?.revenue_usd ?? 0).toFixed(6)),
      unique_clients: agg?.clients.size ?? 0,
    });
  }
  // Money that settled minus money that was never a sale: the hand-logged
  // non-revenue arrivals, and our own self-labelled proving purchases. Computed
  // once so the figure and the sentence describing it cannot disagree — they
  // did once, and the endpoint said "$0.02 settled, of which $0.04 is not
  // revenue".
  // Counted UP from settlements a human promoted, not down by subtracting what
  // we happen to have remembered was not a sale. Subtraction assumes every
  // arrival is revenue until proven otherwise, which is the assumption that put
  // a self-purchase on course to read as the first sale.
  const split = revenueSplit();
  const customerRevenue = split.attributed;

  return {
    persisted: ledgerReady,
    first_event_at: firstEventAt,
    channels: channelSnapshot(),
    unattributed: unattributedHandles(),
    lifetime: {
      ...lifetime,
      // `paid_calls` counts calls that ARRIVED carrying a payment payload, not
      // calls that were paid for. Sitting next to revenue_usd on a public
      // endpoint it reads as "served paid calls, booked no revenue", and two
      // separate readers drew that false alarm from it in one night. The honest
      // name is emitted alongside; the old key stays until the public status
      // page, which reads it, has been republished.
      payment_attempted: lifetime.paid_calls,
      // The number that actually answers "has a stranger used this".
      external_clients: lifetimeExternalClients.size,
      // /healthz is PUBLIC. A non-zero revenue_usd reads to a stranger as
      // "this service has a paying customer", and the raw figure alone cannot
      // say that some of it is our own transfer and a favour from a party who
      // declined to buy. The raw number stays — money really did settle, and
      // hiding it would be its own dishonesty — but it no longer travels alone.
      known_non_revenue_usd: Number(split.knownNonRevenue.toFixed(6)),
      // Our own proving purchases, self-labelled at settlement rather than
      // reconciled afterwards. Kept apart from `known_non_revenue_usd`, which
      // is the hand-logged list: one is a decision made in advance about an
      // identity, the other is a record made after the fact about a specific
      // arrival, and merging them would hide which of the two a number came
      // from.
      self_revenue_usd: Number(split.self.toFixed(6)),
      /**
       * Money that arrived and that nobody has yet said came from a customer.
       * PROMINENT ON PURPOSE: the failure mode this replaces was an invisible
       * zero, and a visible bucket cannot be forgotten because it is the thing
       * being looked at.
       */
      unattributed_revenue_usd: Number(split.unattributed.toFixed(6)),
      attributed_revenue_usd: Number(split.attributed.toFixed(6)),
      revenue_from_customers_usd: Number(customerRevenue.toFixed(6)),
      revenue_note: revenueNote(Number(lifetime.revenue_usd.toFixed(6)), customerRevenue),
      revenue_usd: Number(lifetime.revenue_usd.toFixed(6)),
      unique_clients: lifetimeClients.size,
    },
    daily: series,
  };
}
