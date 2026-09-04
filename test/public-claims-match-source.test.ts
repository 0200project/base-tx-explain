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
