import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { knownNonRevenueReason } from './knownNonRevenue.js';
import { join } from 'node:path';

/**
 * Has a human actually looked at this money and said whose it is?
 *
 * WHY THIS SHAPE, AND WHY THE OBVIOUS ONE IS WRONG. The problem is that our own
 * proving purchase settles `livemode: true` and would report as the first sale
 * on a public endpoint. The two obvious fixes both ask about the PAYER — "prove
 * it is us" or "prove it is a stranger" — and both need something configured
 * before an answer exists, so one of them must fail open, and the open
 * direction is the flattering one. `SELF_PURCHASE_EMAIL` unset turns our own
 * test into a customer.
 *
 * This asks a different question: has anyone attributed this arrival yet? That
 * is a fact about OUR PROCESS, not about the payer, so it is knowable at every
 * moment with no configuration and nothing to forget. The state machine is not
 * self-versus-customer, it is UNATTRIBUTED VERSUS ATTRIBUTED, and unattributed
 * is the birth state of every arrival.
 *
 * BOTH FAILURE DIRECTIONS BECOME SAFE:
 *  - forget to configure the self address → the arrival stays unattributed →
 *    customer revenue under-reports;
 *  - forget to promote a genuine sale → also under-reports.
 * And the second self-corrects in the only way that is reliable here: a first
 * real sale is the most-watched event in this project, so someone will go and
 * look. Nobody ever goes to check whether a number reading $9 should have read
 * $0.
 *
 * IT IS THE SAME RULE AS `never_exercised`. A rotated secret no delivery has
 * tested is unproven rather than working; an arrival nobody has attributed is
 * unattributed rather than earned. Absence of proof is its own state, not an
 * assumption in either direction. Revenue was the last surface still violating
 * that.
 *
 * The unattributed total is surfaced PROMINENTLY rather than merely subtracted,
 * so a forgotten promotion reads "$9 arrived, awaiting attribution" instead of
 * an invisible zero. A loud log asks someone to remember; a visible bucket
 * cannot be forgotten, because it is the thing they are already looking at.
 */

const dataDir = process.env.DATA_DIR ?? './data';
const statePath = join(dataDir, 'attributed-revenue.json');

interface Stored {
  /** Settlement ids a human has confirmed came from a real customer. */
  attributed: string[];
  /** When each was promoted, for audit. */
  at: Record<string, string>;
}

let state: Stored = { attributed: [], at: {} };
let attributed = new Set<string>();
let persistent = false;

/**
 * MUST run before the usage ledger replays, because replay decides which
 * settlements count and needs this set to already be loaded.
 */
export function initAttribution(): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    if (existsSync(statePath)) {
      const raw = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<Stored>;
      state = { attributed: raw.attributed ?? [], at: raw.at ?? {} };
    }
    attributed = new Set(state.attributed);
    persistent = true;
  } catch (err) {
    // In-memory only means promotions are lost on restart, so revenue
    // under-reports until someone re-promotes. That is the safe direction and
    // the reason this degradation is tolerable at all.
    console.error('attribution state unavailable, promotions will not persist:', err);
  }
}

function persist(): void {
  if (!persistent) return;
  try {
    const tmp = `${statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, statePath);
  } catch (err) {
    persistent = false;
    console.error('attribution write failed, continuing in memory:', err);
  }
}

/** Has a human confirmed this settlement came from a real customer? */
export function isAttributed(id: string | undefined): boolean {
  return typeof id === 'string' && id.length > 0 && attributed.has(id);
}

/**
 * A human says this settlement was a real customer.
 *
 * Token-gated at the call site, the same shape and the same reasoning as the
 * webhook-incident acknowledgement: an alarm is worth something only if a
 * stranger cannot silence it, and a sale is worth reporting only if a human
 * said it was one.
 */
export function attribute(
  id: string,
  now = new Date(),
): { promoted: boolean; id: string; reason?: string; why?: string } {
  // REFUSE, DO NOT ACCEPT-AND-SUPPRESS. The bucket logic already ignores a
  // written-off arrival, so storing the promotion anyway would be harmless
  // today and a landmine tomorrow: the entry persists, sits inert only while
  // `isKnownNonRevenue` is checked first, and would ACTIVATE BY ITSELF the day
  // anyone edits KNOWN_NON_REVENUE — money moving into customer revenue with
  // nobody clicking at that moment, caused by a click months earlier.
  //
  // It would also log "attributed to a customer by a human" when no human did
  // and the system does not believe it. An untrue log line is worse than none,
  // because it is what somebody reconstructs from at 2am.
  const why = knownNonRevenueReason(id);
  if (why) return { promoted: false, id, reason: 'known_non_revenue', why };
  if (!id || attributed.has(id)) return { promoted: false, id };
  attributed.add(id);
  state.attributed.push(id);
  state.at[id] = now.toISOString();
  persist();
  console.log(`[revenue] settlement ${id.slice(0, 24)} attributed to a customer by a human`);
  return { promoted: true, id };
}

/** Undo a promotion — a mistake must be reversible, or nobody will promote. */
export function unattribute(id: string): { removed: boolean } {
  if (!attributed.delete(id)) return { removed: false };
  state.attributed = state.attributed.filter((x) => x !== id);
  delete state.at[id];
  persist();
  return { removed: true };
}

export function attributionSnapshot(): Record<string, unknown> {
  return { count: attributed.size, promoted_at: state.at };
}

/** Test seam. */
export function _resetAttribution(): void {
  state = { attributed: [], at: {} };
  attributed = new Set();
  persistent = false;
}
