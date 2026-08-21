import { describe, expect, it } from 'vitest';
import { passFromHeaders, passFromPath, passUrl, redactPassPath } from '../src/passUrl.js';

/**
 * The URL-path pass form exists so setup is one paste of one URL, for the many
 * MCP clients that offer a URL field and no way to set a header.
 *
 * Two properties carry real risk and are tested hardest: the matcher must not
 * accept anything we did not mint (a permissive pattern turns the URL space
 * into a guessing game against the pass store), and redaction must not miss a
 * token (a miss writes a live credential into logs permanently, which is the
 * one leak surface we actually control).
 */

const TOKEN = `btxp_${'a1b2c3d4'.repeat(6)}`; // 48 hex chars

describe('passFromPath', () => {
  it('reads a token from the canonical path', () => {
    expect(passFromPath(`/mcp/${TOKEN}`)).toBe(TOKEN);
  });

  it('ignores a query string and fragment, which are not part of the credential', () => {
    expect(passFromPath(`/mcp/${TOKEN}?x=1`)).toBe(TOKEN);
    expect(passFromPath(`/mcp/${TOKEN}#frag`)).toBe(TOKEN);
  });

  it('returns null for the plain endpoint so free and header-auth calls are untouched', () => {
    expect(passFromPath('/mcp')).toBeNull();
    expect(passFromPath('/mcp/')).toBeNull();
  });

  it('returns null for other routes', () => {
    expect(passFromPath('/explain')).toBeNull();
    expect(passFromPath(`/pass/${TOKEN}`)).toBeNull();
    expect(passFromPath('/')).toBeNull();
  });

  it('rejects anything not shaped like a token we mint', () => {
    // A loose matcher would let callers probe the pass store through the URL
    // space. Only the exact minted shape may pass.
    expect(passFromPath('/mcp/btxp_short')).toBeNull();
    expect(passFromPath(`/mcp/${TOKEN.toUpperCase()}`)).toBeNull();
    expect(passFromPath(`/mcp/${TOKEN}x`)).toBeNull();
    expect(passFromPath(`/mcp/wrong_${'a1b2c3d4'.repeat(6)}`)).toBeNull();
    expect(passFromPath(`/mcp/btxp_${'z'.repeat(48)}`)).toBeNull();
  });

  it('rejects extra path segments rather than matching loosely', () => {
    expect(passFromPath(`/mcp/${TOKEN}/extra`)).toBeNull();
    expect(passFromPath(`/api/mcp/${TOKEN}`)).toBeNull();
  });
});

describe('redactPassPath', () => {
  it('keeps a live token out of our own logs', () => {
    const out = redactPassPath(`POST /mcp/${TOKEN} 200`);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain('/mcp/btxp_<redacted>');
  });

  it('still shows that a pass call happened', () => {
    // Redacting the whole path would lose the signal that a pass was used,
    // which is exactly what the logs are for.
    expect(redactPassPath(`/mcp/${TOKEN}`)).toBe('/mcp/btxp_<redacted>');
  });

  it('redacts every occurrence, not just the first', () => {
    const two = `/mcp/${TOKEN} -> /mcp/${TOKEN}`;
    expect(redactPassPath(two).match(/redacted/g)).toHaveLength(2);
  });

  it('leaves paths without a token alone', () => {
    expect(redactPassPath('/mcp')).toBe('/mcp');
    expect(redactPassPath('/explain')).toBe('/explain');
  });
});

describe('passUrl', () => {
  it('builds the string a buyer pastes', () => {
    expect(passUrl('https://base-tx-explain.fly.dev', TOKEN)).toBe(
      `https://base-tx-explain.fly.dev/mcp/${TOKEN}`,
    );
  });

  it('does not double the slash when the base url has a trailing one', () => {
    // Every surface that shows this string builds it here, so one wrong slash
    // would appear identically in checkout, docs and the REST response.
    expect(passUrl('https://base-tx-explain.fly.dev/', TOKEN)).toBe(
      `https://base-tx-explain.fly.dev/mcp/${TOKEN}`,
    );
  });

  it('round-trips: what we hand the buyer is what the server will read', () => {
    const url = passUrl('https://base-tx-explain.fly.dev', TOKEN);
    const path = new URL(url).pathname;
    expect(passFromPath(path)).toBe(TOKEN);
  });
});

describe('passFromHeaders', () => {
  /**
   * claude.ai custom connectors accept only an allowlist of standard auth
   * header names — authorization, x-api-key, x-auth-token. Our original
   * X-BTX-Pass is not on it and cannot be sent there at all, so accepting the
   * standard forms is the difference between working and not working on that
   * surface.
   */
  it('accepts the original custom header', () => {
    expect(passFromHeaders({ 'x-btx-pass': TOKEN })).toBe(TOKEN);
  });

  it('accepts Authorization: Bearer, which is what allowlisted clients can send', () => {
    expect(passFromHeaders({ authorization: `Bearer ${TOKEN}` })).toBe(TOKEN);
    expect(passFromHeaders({ authorization: `bearer ${TOKEN}` })).toBe(TOKEN);
  });

  it('accepts a bare Authorization value without the Bearer prefix', () => {
    expect(passFromHeaders({ authorization: TOKEN })).toBe(TOKEN);
  });

  it('accepts x-api-key and x-auth-token', () => {
    expect(passFromHeaders({ 'x-api-key': TOKEN })).toBe(TOKEN);
    expect(passFromHeaders({ 'x-auth-token': TOKEN })).toBe(TOKEN);
  });

  it('ignores an unrelated Authorization header rather than reading it as a failed pass', () => {
    // A proxy's own credential must not be mistaken for a bad pass, which would
    // turn someone else's infrastructure into an authentication error for us.
    expect(passFromHeaders({ authorization: 'Bearer sk_live_abc123' })).toBeNull();
    expect(passFromHeaders({ authorization: 'Basic dXNlcjpwYXNz' })).toBeNull();
    expect(passFromHeaders({ 'x-api-key': 'some-other-service-key' })).toBeNull();
  });

  it('returns null when no header carries a pass', () => {
    expect(passFromHeaders({})).toBeNull();
    expect(passFromHeaders({ 'content-type': 'application/json' })).toBeNull();
  });

  it('ignores non-string header values', () => {
    expect(passFromHeaders({ authorization: ['a', 'b'] })).toBeNull();
    expect(passFromHeaders({ 'x-btx-pass': undefined })).toBeNull();
  });
});
