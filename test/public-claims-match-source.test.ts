import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * EVERY CURRENT-TENSE CLAIM ON THE PUBLIC SITE HAS A SOURCE OF TRUTH IN THIS
 * REPO, AND NOBODY WAS DIFFING THEM.
 *
 * The privacy page said "no database, no request archive, no user records"
 * while `usage.ts` described an append-only JSONL ledger on a persistent volume
 * that, in its own words, "holds every one forever" — including the payer's
 * wallet address on failed payments. Both statements were public. Neither was
 * checked against the other, and it was found by a human reading two files.
 *
 * A site claim and the code that makes it true are edited by different people
 * at different times for different reasons. Nothing but a test connects them.
 *
 * ⚠️ THE CHANGELOG IS DELIBERATELY EXEMPT. It is a dated historical record: the
 * v0.1.0 entry correctly says "10 free calls per client" because that is what
 * shipped on 2026-08-20, and a later entry records the change to 50. Asserting
 * current values against dated history would generate false failures and train
 * everyone to ignore this file — which is worse than not having it.
 */

const root = new URL('..', import.meta.url).pathname;
const flyToml = readFileSync(join(root, 'fly.toml'), 'utf8');
const usageSrc = readFileSync(join(root, 'src/usage.ts'), 'utf8');

function currentTensePages(): Array<{ path: string; html: string }> {
  const out: Array<{ path: string; html: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        // The changelog is DATED HISTORY, not a current-tense claim: its v0.1.0
        // entry correctly says "10 free calls per client" for 2026-08-20, and a
        // later entry records the change to 50. Asserting today's values against
        // it would produce false failures and train everyone to ignore this file.
        // ⚠️ THE EXEMPTION IS FILE-SHAPED AND CONTAINERS ACQUIRE CONTENTS: a
        // current-tense summary added to the top of that page would be invisible
        // to every assertion here, permanently. If that ever happens, exempt
        // dated ENTRIES rather than the directory.
        if (entry === 'changelog' || entry === 'assets') continue;
        walk(p);
      } else if (entry.endsWith('.html')) {
        out.push({ path: p.slice(root.length), html: readFileSync(p, 'utf8') });
      }
    }
  };
  walk(join(root, 'site'));
  return out;
}

const setting = (key: string): string => {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*'([^']+)'`, 'm').exec(flyToml);
  if (!m) throw new Error(`${key} not found in fly.toml — did the source of truth move?`);
  return m[1];
};

describe('public site claims match the code that makes them true', () => {
  it('finds pages to check, so a path change cannot silently empty this test', () => {
    expect(currentTensePages().length).toBeGreaterThan(5);
  });

  it('every free-call figure equals FREE_CALLS_PER_IP', () => {
    const expected = setting('FREE_CALLS_PER_IP');
    const wrong: string[] = [];
    for (const { path, html } of currentTensePages()) {
      for (const m of html.matchAll(/(\d+) free calls/g)) {
        if (m[1] !== expected) wrong.push(`${path}: "${m[0]}" but fly.toml says ${expected}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('every per-call price equals X402_PRICE_USD', () => {
    const expected = setting('X402_PRICE_USD');
    const wrong: string[] = [];
    for (const { path, html } of currentTensePages()) {
      for (const m of html.matchAll(/\$?([\d.]+)\s*(?:USDC\s*)?per call/g)) {
        const v = m[1].replace(/^\$/, '');
        if (Number(v) !== Number(expected)) wrong.push(`${path}: "${m[0]}" but fly.toml says ${expected}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  /**
   * The specific failure that motivated this file. Stated as an implication
   * rather than a keyword ban: the claim is only forbidden WHILE the code makes
   * it false. If retention is ever actually removed, this test stops objecting
   * on its own instead of having to be remembered and deleted.
   */
  /**
   * ⚠️ THIS ASSERTS THE PRESENCE OF THE TRUE STATEMENT, NOT THE ABSENCE OF THE
   * FALSE ONE — and the direction is the whole point.
   *
   * The first version banned the substrings "no database", "no request archive",
   * "no user records". An HONEST correction must contain them: once in the true
   * sentence explaining what is and is not kept, and again in a dated note
   * quoting what the page used to say. So the guard fired RED against the
   * corrected page and the cheapest way to make it green was to delete the
   * disclosure it existed to force. A guard that converts into its own opposite
   * under time pressure is worse than no guard, because it goes green when it
   * succeeds in causing the harm.
   *
   * A presence test cannot be satisfied by deletion and cannot fire on a
   * quotation. Absence tests fail at both.
   */
  it('states the retention it actually performs, while it performs it', () => {
    // Keyed on the write call and the stored field, not on comments about them.
    const appendsForever = /appendFileSync\(\s*ledgerPath/.test(usageSrc);
    const storesPayer = /payer\?: string/.test(usageSrc);
    if (!appendsForever || !storesPayer) return; // behaviour changed; the duty changes with it

    const privacy = currentTensePages().find((p) => p.path.includes('privacy'));
    expect(privacy, 'privacy page not found — did the path move?').toBeDefined();
    const text = privacy!.html.replace(/<[^>]+>/g, ' ');

    // It must SAY it keeps a per-event record...
    expect(text).toMatch(/append-only|event log|record of requests/i);
    // ...and that a wallet address is part of what that record links.
    expect(text).toMatch(/wallet address|payer/i);
  });

  /**
   * ⚠️ A TRAP SET FOR A FUTURE EDITOR WHO WILL BELIEVE THEY ARE IMPROVING THE PAGE.
   *
   * /security/ says blocklists are "consumed read-only from public sources
   * (ScamSniffer and MyEtherWallet), refreshed twice daily". Every clause is
   * true: the deployed drainers.ts queries both and REFRESH_MS is 12 hours.
   *
   * But "refreshed twice daily" is a statement about OUR POLLING that a reader
   * takes as a statement about THE DATA — and the ScamSniffer path we read has
   * not changed since 2024-02-28. The sentence survives only because nothing
   * near it claims the list is current. Add "current", "up to date" or "live"
   * and a true sentence becomes a lie, and the repoint does not rescue it,
   * because the corrected source is lagged seven days by its vendor's own README.
   *
   * SO THIS IS DELIBERATELY AN ABSENCE TEST, against my own preference for
   * presence tests, and the reason the usual objection does not apply: the
   * hazard here is an ADDITION, and a presence test cannot catch a word being
   * added. Deleting the sentence entirely is a fine outcome — no claim, no lie —
   * so there is nothing this guard can be satisfied by destroying.
   */
  it('never claims the drainer blocklist is current, while the source we read is not', () => {
    const drainers = readFileSync(join(root, 'src/risk/drainers.ts'), 'utf8');
    // Retires itself if we ever read a source that publishes no lag and is live.
    const readsLaggedOrFrozen = /scamsniffer|darklist|lag/i.test(drainers);
    if (!readsLaggedOrFrozen) return;

    const CURRENCY = /\b(current|up[- ]to[- ]date|live|real[- ]time|latest|always fresh|continuously updated)\b/i;
    const found: string[] = [];
    for (const { path, html } of currentTensePages()) {
      const text = html.replace(/<[^>]+>/g, ' ');
      // Only the neighbourhood of the blocklist claim, so unrelated uses of
      // "latest" elsewhere on the site do not fire this.
      for (const m of text.matchAll(/blocklist|drainer|ScamSniffer|MyEtherWallet/gi)) {
        const near = text.slice(Math.max(0, m.index! - 200), m.index! + 200);
        const hit = CURRENCY.exec(near);
        if (hit) found.push(`${path}: "${hit[0]}" within 200 chars of "${m[0]}"`);
      }
    }
    expect(
      [...new Set(found)],
      'A currency word appeared beside the blocklist claim. The list we read has ' +
        'not changed since 2024-02-28 and the corrected source is lagged seven ' +
        'days by its vendor. Say how often WE FETCH, never how fresh the data is.',
    ).toEqual([]);
  });

  /**
   * ⚠️ A PUBLISHED BILLING PROMISE THAT SILENTLY DEPENDS ON AN ENV VAR.
   *
   * The refund rule the site states is true only while the service is charging.
   * The whole MCP refund block is gated on `PAYMENT_MODE === 'x402'`
   * (index.ts), and PAYMENT_MODE DEFAULTS TO 'none' — so flipping it turns those
   * pages into a description of a configuration we no longer run, silently.
   *
   * Prose cannot catch that, and hedging the sentence would be worse: a reader
   * cannot experience the exception, because if we are not charging the billing
   * paragraph is moot rather than wrong. So the duty is a BUILD-TIME one — while
   * the claim is published, the deployed config must match it.
   *
   * Keyed on fly.toml because that is where the deployed value actually lives.
   * A source test cannot read a runtime env var, and asserting the default would
   * assert the wrong thing: the default is 'none'.
   */
  it('pins PAYMENT_MODE while the site publishes a refund promise', () => {
    const pages = currentTensePages();
    // ⚠️ NARROW ON PURPOSE, AND THE FIRST VERSION WAS NOT.
    //
    // It matched the bare word "consumed", which appears on /docs/ and
    // /security/ in "blocklists are CONSUMED read-only from public sources" —
    // prose about data sources, not billing. The guard passed, and it passed for
    // a reason that had nothing to do with the claim it exists to protect. Worse,
    // the failure message named /security/, so a future deployer reading it would
    // have been sent to edit a page that never made the claim.
    //
    // These patterns describe what is being PROMISED about a call, so unrelated
    // uses of "consumed" cannot satisfy them.
    const claims = pages.filter(({ html }) => {
      const text = html.replace(/<[^>]+>/g, ' ');
      return /\brefunded\b|consumes? a (free )?call|costs? (you )?a call|counts? against your/i.test(text);
    });
    // No claim published means no duty. Stated rather than silent, so a future
    // reader can tell a vacuous pass from a real one.
    if (claims.length === 0) return;
    expect(
      /^\s*PAYMENT_MODE\s*=\s*'x402'/m.test(flyToml),
      `pages assert refund behaviour (${claims.map((c) => c.path).join(', ')}) ` +
        `but fly.toml does not pin PAYMENT_MODE='x402' — the claim would describe a config we do not run`,
    ).toBe(true);
  });

  it('does not deny storing identifiers while the ledger stores a payer address', () => {
    const storesPayer = /payer\?: string/.test(usageSrc);
    if (!storesPayer) return;
    const found: string[] = [];
    for (const { path, html } of currentTensePages()) {
      const m = /(we do not|we don.t|never) (store|keep|retain|log)[^.<]{0,40}(address|identifier|wallet)/i.exec(html);
      if (m) found.push(`${path}: "${m[0]}"`);
    }
    expect(found).toEqual([]);
  });
});
