/**
 * Pass tokens carried in the MCP URL path, so setup is one paste of one URL.
 *
 * The token is normally presented as an `X-BTX-Pass` header or at
 * `_meta["btx/pass"]`. Both require the buyer to configure a server AND
 * separately attach a credential, and most MCP clients offer a single URL field
 * and no way to set a header at all. For those clients the header form is not
 * merely inconvenient, it is unusable.
 *
 * Putting the token in the path collapses setup to pasting one string:
 *
 *   https://base-tx-explain.fly.dev/mcp/btxp_<hex>
 *
 * ---
 *
 * WHY THIS IS ACCEPTABLE HERE, AND WHERE IT WOULD NOT BE
 *
 * A URL-borne secret leaks in ways a header does not: access logs, proxy logs,
 * browser history, Referer headers. That is disqualifying for a credential that
 * moves money or unlocks an account. This one does neither.
 *
 * The worst case is that someone spends decode calls the buyer paid for, capped
 * by the pass. There is no PII behind the token, no funds it can move, no
 * account it can take over, and it expires. Against that, the alternative is a
 * product a large share of clients cannot configure at all.
 *
 * Mitigations that make the trade sound rather than merely tolerable:
 *  - The server stores only a hash of each token, so logs are the exposure, not
 *    the store.
 *  - Tokens are per-purchase and revocable.
 *  - `redactPassPath` below keeps the token out of OUR logs, which is the one
 *    leak surface we control.
 *  - The header and `_meta` forms still work, so a client that CAN send a header
 *    never has to put the token in a URL.
 *
 * If a pass ever carries anything beyond metered calls, this stops being
 * acceptable and the URL form must go.
 */

/** Pass tokens are minted as `btxp_` + 48 hex characters. */
const TOKEN_PATTERN = /^btxp_[0-9a-f]{48}$/;

/**
 * A token-bearing MCP path, or null.
 *
 * Deliberately strict: only an exact `/mcp/<token>` shape matches, and the
 * token must look like one we mint. Anything else returns null so the caller
 * treats it as an ordinary unauthenticated request rather than a failed
 * authentication — a malformed path is not a wrong password, and must not be
 * reported as one.
 */
export function passFromPath(path: string): string | null {
  // Query strings and fragments are not part of the credential.
  const clean = (path.split('?')[0] ?? '').split('#')[0] ?? '';
  const parts = clean.split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0] !== 'mcp') return null;
  const candidate = parts[1] ?? '';
  return TOKEN_PATTERN.test(candidate) ? candidate : null;
}

/**
 * Replace a pass token in a path with a stable marker for logging.
 *
 * Every request path we log would otherwise carry a live credential in plain
 * text, on disk, for as long as logs are kept — turning a bounded, deliberate
 * exposure into a permanent one in the one place we control. The marker keeps
 * the line useful (you can still see a pass call happened) without recording
 * which pass.
 */
export function redactPassPath(path: string): string {
  return path.replace(/\/mcp\/btxp_[0-9a-f]{48}/g, '/mcp/btxp_<redacted>');
}

/**
 * The URL a buyer pastes into their client.
 *
 * Built here rather than by string-concatenation at each call site so the
 * checkout page, the success page, the REST response and the docs cannot drift
 * into disagreeing about the shape of the one string a customer is told to copy.
 */
export function passUrl(publicUrl: string, token: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/mcp/${token}`;
}
