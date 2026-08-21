/**
 * The single identity the free tier, the rate limiter and the usage ledger key on.
 *
 * WHY THIS IS NOT JUST THE IP ADDRESS
 *
 * IPv4 is scarce, so one address is a reasonable stand-in for one client. IPv6 is
 * not: the smallest routed allocation is a /64, and any commodity VPS or home
 * connection gets at least that. A caller who binds a new source address per
 * request therefore presents 2^64 distinct identities without doing anything
 * unusual — each one a fresh 10-call free tier and a fresh 60/minute window.
 * Keying on the full address makes the paywall and the throttle optional for
 * anyone on IPv6, and the fix is not to detect the rotation but to stop treating
 * addresses within one allocation as different clients.
 *
 * A /64 is the closest IPv6 equivalent of what an IPv4 address already means in
 * practice: one subscriber line, one household, one instance. Collapsing to it
 * makes the two families behave the same way rather than making IPv6 stricter —
 * an IPv4 household behind NAT has always shared one bucket.
 *
 * This is also the identity the ledger hashes into `client`, so unique-client
 * counts cannot be inflated by the same rotation. That is deliberate: a number
 * used to answer "has a stranger used this" must not be trivially forgeable by
 * one stranger.
 */

/** Expand an IPv6 address to its 8 hextets, or null if it is not one we can parse. */
function expandIpv6(addr: string): string[] | null {
  const halves = addr.split('::');
  if (halves.length > 2) return null; // `::` may appear at most once

  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];

  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array.from({ length: missing }, () => '0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const out: string[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null; // rejects IPv4-embedded forms
    out.push(Number.parseInt(g, 16).toString(16)); // canonical: lowercase, no leading zeros
  }
  return out;
}

/**
 * Normalise a client address into the key we count against.
 *
 * IPv4 (including IPv4-mapped IPv6) keeps its exact address. IPv6 collapses to
 * its /64 prefix. Anything unrecognised is returned unchanged rather than
 * coarsened, because collapsing addresses we do not understand risks merging
 * unrelated strangers into one bucket — the direction that loses real signal.
 */
export function clientKey(rawIp: string | null | undefined): string {
  const ip = (rawIp ?? '').trim();
  if (!ip) return 'unknown';

  // `[::1]` bracket form and a `%eth0` zone index are addressing syntax, not identity.
  const bare = (ip.replace(/^\[/, '').replace(/\]$/, '').split('%')[0] ?? '').trim();
  if (!bare) return 'unknown';

  if (!bare.includes(':')) return bare; // IPv4

  // ::ffff:1.2.3.4 and ::1.2.3.4 are an IPv4 client wearing IPv6 syntax; the
  // IPv4 address is the real identity and stays exact.
  const mapped = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
  if (mapped?.[1]) return mapped[1];

  const groups = expandIpv6(bare);
  if (!groups) return bare;

  return `${groups.slice(0, 4).join(':')}::/64`;
}
