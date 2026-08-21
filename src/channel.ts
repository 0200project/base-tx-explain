/**
 * Which listing brought a caller, so distribution can be measured instead of assumed.
 *
 * WHY THIS EXISTS. Six discovery listings are live — MCP registry, Apify, Glama,
 * x402scan, and two open PRs — and a seventh was proposed for $0.05. Nobody can
 * say whether any of the six produced a single client. Six lifetime unique
 * clients, at least two provably us and one arriving from direct outreach, and
 * a caller from a registry is indistinguishable from a caller from anywhere
 * else. The segment research concluded distribution is the actual constraint;
 * being unable to measure distribution is therefore the thing worth fixing
 * before buying an eighth listing.
 *
 * We control the URL handed to each registry, so `?ref=<channel>` on it makes
 * arrivals countable per channel.
 *
 * ---
 *
 * THREE PROPERTIES THIS DELIBERATELY HAS, each one a lesson from a counter that
 * lied earlier the same day.
 *
 * 1. IT IS SELF-REPORTED, SO IT IS A HINT AND NOT PROOF. Anyone can send
 *    `?ref=glama`. Nothing here verifies the claim and nothing could — the
 *    caller writes it. Every surface that prints these numbers must say so.
 *    A number that reads as fact when it is a claim is exactly the failure that
 *    put "payment attempts" in a revenue column.
 *
 * 2. ABSENT AND UNRECOGNISED EACH GET THEIR OWN BUCKET. No `ref` is `direct`;
 *    an unknown `ref` is `other`. Neither is dropped and neither is folded into
 *    a real channel, because a category with nowhere to go lands somewhere, and
 *    it lands somewhere flattering — that is precisely how an outage giveaway
 *    would have been counted as paywall demand.
 *
 * 3. IT IS AN ALLOWLIST, NOT A CAP-AND-EVICT MAP. The value is
 *    attacker-controlled, so an unbounded set of channels is a memory-growth
 *    vector. A capped map would bound memory but not the measurement: someone
 *    flooding distinct values fills the cap and pushes our real channels into
 *    the overflow, corrupting the very number this exists to produce. An
 *    allowlist is bounded by construction and cannot be polluted. The cost is
 *    an env change to add a listing, which is appropriate — adding a listing is
 *    a deliberate act, not something that should happen because a stranger sent
 *    a query string.
 */

/** No `ref` at all: someone who arrived without going through a listing. */
export const DIRECT = 'direct';
/** A `ref` we do not recognise. Kept separate rather than discarded. */
export const OTHER = 'other';

/**
 * Shape a channel tag must have to be considered at all. Short, lowercase,
 * alphanumeric with dashes and underscores. This is a sanity filter on the
 * string, not a security control — the allowlist below is what actually bounds
 * anything.
 */
const SHAPE = /^[a-z0-9][a-z0-9_-]{0,23}$/;

/** Hard cap applied to the raw value before ANY other work touches it. */
const MAX_RAW = 64;

/**
 * The listings we have actually made. Override with `CHANNELS` (comma
 * separated) so a new listing does not need a deploy of new code — but it does
 * need a deliberate act, which is the point.
 */
const DEFAULT_CHANNELS = [
  'mcp-registry',
  'apify',
  'glama',
  'x402scan',
  'x402-eco',
  'awesome-mcp',
  'aegis',
  'site',
  'github',
  'readme',
];

function loadAllowed(): Set<string> {
  const raw = process.env.CHANNELS;
  const list = (raw ? raw.split(',') : DEFAULT_CHANNELS)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => SHAPE.test(s));
  return new Set(list);
}

let allowed = loadAllowed();

/**
 * Say what is being measured, at boot.
 *
 * A misconfigured `CHANNELS` would send every arrival to `other`, and the
 * instrument would then report "no listing produced anything" — which is
 * precisely the conclusion it exists to test, arriving from a config slip
 * rather than from reality. Same class as the drainer list going dark: a
 * control that quietly does nothing looks exactly like a control reporting
 * good news. There is a default list in code so an unset variable degrades to
 * measuring rather than to silence.
 */
export function logChannelConfig(): void {
  console.log(
    `channel attribution: ${allowed.size} listing(s) measurable [${knownChannels().join(', ')}]` +
      `${process.env.CHANNELS ? '' : ' (built-in default; CHANNELS not set)'}`,
  );
}

/** Test seam: re-read `CHANNELS` after the environment changes. */
export function _reloadChannels(): void {
  allowed = loadAllowed();
}

/** Every bucket that can appear, so a report can show zeroes rather than gaps. */
export function knownChannels(): string[] {
  return [...allowed].sort();
}

/**
 * The channel a request claims to have come from.
 *
 * Never throws and never returns null: every call belongs to exactly one
 * bucket, so the totals always reconcile against the call count. A caller that
 * supplies nothing is `direct`; one that supplies something unrecognised is
 * `other`.
 */
export function channelOf(query: unknown, headers?: Record<string, unknown>): string {
  const fromQuery = (query as { ref?: unknown } | undefined)?.ref;
  const fromHeader = headers?.['x-btx-ref'];
  const raw = typeof fromQuery === 'string' ? fromQuery : typeof fromHeader === 'string' ? fromHeader : '';

  // TRUNCATE BEFORE TOUCHING IT. `ref` is attacker-chosen, and lowercasing or
  // logging a megabyte string is a free write into our memory and our log
  // volume. The cap comes first so nothing downstream — including the
  // diagnostic below — can ever see more than this.
  const tag = raw.slice(0, MAX_RAW).trim().toLowerCase();
  if (!tag) return DIRECT;
  if (!SHAPE.test(tag) || !allowed.has(tag)) {
    noteUnrecognised(tag);
    return OTHER;
  }
  return tag;
}

/**
 * Say once, to stderr, that an unrecognised channel arrived.
 *
 * The point is a forgotten listing: if a registry is sending traffic under a
 * tag nobody added to `CHANNELS`, that reads as "the listing produced nothing"
 * and is indistinguishable from the truth we are trying to measure. One line
 * makes it diagnosable.
 *
 * Never into the ledger and never onto the dashboard — only the bucket name
 * `other` goes there. The value is a string an attacker picks, and a
 * caller-controlled string rendered on the founder's dashboard is the
 * token-symbol injection surface on a new rail. Bounded to a handful of
 * distinct values per process so it cannot become a log-flooding channel of
 * its own, and sanitised on the way out because "we capped the length" is not
 * the same as "it is safe to print".
 */
const UNRECOGNISED_LOG_CAP = 10;
const unrecognisedSeen = new Set<string>();
function noteUnrecognised(tag: string): void {
  if (!tag || unrecognisedSeen.has(tag) || unrecognisedSeen.size >= UNRECOGNISED_LOG_CAP) return;
  unrecognisedSeen.add(tag);
  const safe = tag.replace(/[^a-z0-9_-]/g, '.').slice(0, 32);
  console.error(
    `[channel] unrecognised ref "${safe}" — counted as "${OTHER}". ` +
      'If this is a real listing of ours, add it to CHANNELS or its arrivals stay unattributed.',
  );
}

/**
 * One sentence for any surface that prints these counts.
 *
 * Exported rather than written per-surface because the same caveat had to
 * appear on the dashboard, on `/stats` and in the daily report, and three
 * copies of one caveat drift — the copy that drifts being the one somebody
 * external is reading.
 */
export const CHANNEL_CAVEAT =
  'Channel is self-reported by the caller via ?ref= and is not verified: treat it as a hint, not proof. ' +
  '"direct" means no channel was supplied, "other" means one was supplied that we do not recognise. ' +
  'Our own marked internal traffic is excluded entirely.';
