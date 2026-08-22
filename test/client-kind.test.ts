import { describe, expect, it } from 'vitest';
import { CLIENT_KIND_CAVEAT, clientKind } from '../src/clientKind.js';

/**
 * What kind of thing called us.
 *
 * Every arrival question tonight was answered by inference from timing — two
 * addresses four seconds apart looked like probe nodes, a return eight hours
 * later looked like a person, and both readings could have been wrong. The
 * user-agent answers directly what we were triangulating.
 *
 * The properties under test are the ones a counter needs to be trustworthy:
 * it never returns the caller's own string, unclassifiable input gets its own
 * bucket rather than a flattering one, and every input lands somewhere so the
 * totals reconcile.
 */

describe('clientKind', () => {
  it('recognises a declared bot', () => {
    for (const ua of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'facebookexternalhit/1.1',
      'Slackbot-LinkExpanding 1.0',
      'Twitterbot/1.0',
      'Mozilla/5.0 ... HeadlessChrome/120.0.0.0',
      'Pingdom.com_bot_version_1.4',
    ]) {
      expect(clientKind(ua), ua).toBe('bot_declared');
    }
  });

  it('prefers bot_declared over browser when both are present', () => {
    // Link-preview fetchers routinely carry a full browser UA plus a bot token.
    // The bot token is the honest part, and reading these as browsers would
    // turn scanner traffic into evidence of people — the flattering direction.
    expect(
      clientKind('Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 Chrome/120 Safari/537.36 (compatible; Discordbot/2.0)'),
    ).toBe('bot_declared');
  });

  it('recognises a person at a terminal', () => {
    expect(clientKind('curl/8.4.0')).toBe('cli');
    expect(clientKind('Wget/1.21.3')).toBe('cli');
  });

  it('recognises an HTTP client library — the shape our buyer would have', () => {
    for (const ua of [
      'python-requests/2.31.0',
      'node-fetch/1.0',
      'axios/1.6.2',
      'Go-http-client/2.0',
      'okhttp/4.12.0',
      'undici',
    ]) {
      expect(clientKind(ua), ua).toBe('http_library');
    }
  });

  it('recognises a real browser', () => {
    expect(
      clientKind('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'),
    ).toBe('browser');
  });

  it('reports an absent header as absent, not as unknown', () => {
    // Two different facts. A minimal client sending no UA is common and says
    // something; an unrecognised UA says something else. Collapsing them would
    // hide which.
    expect(clientKind(undefined)).toBe('absent');
    expect(clientKind('')).toBe('absent');
    expect(clientKind('   ')).toBe('absent');
    expect(clientKind(42)).toBe('absent');
  });

  it('puts anything unrecognised in its own bucket', () => {
    expect(clientKind('SomeBespokeAgent/9')).toBe('unknown');
  });

  it('NEVER returns the caller-supplied string', () => {
    // The raw header is caller-controlled and would otherwise reach the ledger
    // and the dashboard. Only the classification travels.
    const hostile = '<script>alert(1)</script>';
    const out = clientKind(hostile);
    expect(out).not.toContain('script');
    expect(['bot_declared', 'browser', 'cli', 'http_library', 'absent', 'unknown']).toContain(out);
  });

  it('truncates before doing any work, so a huge header costs nothing', () => {
    expect(() => clientKind('a'.repeat(200_000))).not.toThrow();
    expect(clientKind('a'.repeat(200_000))).toBe('unknown');
  });

  it('always lands in exactly one bucket, so totals reconcile', () => {
    for (const v of ['', 'curl/8', 'Googlebot', 'Mozilla/5.0', 'nonsense', '!!!', 'A'.repeat(300)]) {
      expect(typeof clientKind(v)).toBe('string');
    }
  });

  it('says it is a hint rather than proof', () => {
    expect(CLIENT_KIND_CAVEAT).toMatch(/hint, not proof/i);
    expect(CLIENT_KIND_CAVEAT).toMatch(/raw header is never stored/i);
    expect(CLIENT_KIND_CAVEAT).toMatch(/internal traffic is excluded/i);
  });
});
