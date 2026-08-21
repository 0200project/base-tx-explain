import { describe, expect, it } from 'vitest';
import { passFromPath, passUrl, redactPassPath } from '../src/passUrl.js';

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
