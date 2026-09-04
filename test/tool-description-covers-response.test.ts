import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// WHY THIS EXISTS. Five fields shipped in every response while the agent-facing
// tools/list description named none of them: block_number, tx_hash, status,
// partial, and provenance. provenance is the safety-relevant one -- it carries
// untrusted_fields, the list of response fields whose strings are controlled by
// the transaction's author, and the standing instruction to treat them as data
// and never as instructions. The tool description is what an agent reads BEFORE
// our documentation and before it pipes `summary` into its own reasoning, so an
// undocumented provenance meant an agent had no way to learn that part of what
// we return is attacker-controlled.
//
// Asserting on today's five would only re-prove today's bug. This derives the
// field list from the ExplainResult interface, so a field added tomorrow and
// left out of the description fails here on the day it is added.

const types = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');
const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

function explainResultFields(): string[] {
  const body = types.match(/export interface ExplainResult \{([\s\S]*?)\n\}/)?.[1];
  if (!body) throw new Error('ExplainResult interface not found - did types.ts move?');
  return [...body.matchAll(/^\s{2}(\w+)[?]?:/gm)].map((m) => m[1]);
}

/**
 * The SOURCE TEXT of the declaration. Useful for checking how it is written;
 * useless for checking what an agent receives. See below.
 */
function toolDescriptionSource(): string {
  const d = index.match(/const TOOL_DESCRIPTION =([\s\S]*?);\n/)?.[1];
  if (!d) throw new Error('TOOL_DESCRIPTION not found - did index.ts move?');
  return d;
}

/**
 * The VALUE an agent actually receives, reconstructed by honouring the same
 * rule the JS parser does.
 *
 * ⚠️ WHY THIS IS NOT THE SOURCE TEXT. This test used to read the declaration's
 * text, which meant it could not see the one thing it exists to prevent. Two
 * lines of the concatenation lost their trailing `+`; adjacent string literals
 * do not continue an expression, so ASI inserted a semicolon and everything
 * after became dead code. The description silently shrank from ~1,600
 * characters to 562 — dropping timestamp, block_number, tx_hash, basescan_url,
 * status, partial, provenance AND the standing instruction to treat
 * attacker-controlled fields as data. It typechecked. It shipped. Every field
 * this test names was still present in the SOURCE, so the test passed.
 *
 * A gate that reads the source of the thing it guards, rather than the thing,
 * certifies whatever it cannot see.
 */
function toolDescription(): string {
  const lines = toolDescriptionSource().split('\n');
  let out = '';
  let needsPlus = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t || t.startsWith('//')) continue;
    if (needsPlus && t.startsWith("'")) break; // ASI cut the expression here
    const lit = /^'(.*)'\s*(\+?)\s*$/.exec(t);
    if (!lit) continue;
    out += lit[1].replace(/\\'/g, "'");
    needsPlus = lit[2] !== '+';
  }
  return out;
}

describe('tools/list description covers what we actually return', () => {
  it('is not silently truncated by a missing concatenation operator', () => {
    // The whole declaration must survive into the value. A dropped `+` does not
    // fail to compile — it ends the expression and discards the rest.
    const sourceLiterals = (toolDescriptionSource().match(/^\s*'.*'/gm) ?? []).length;
    const value = toolDescription();
    const valueLiterals = (toolDescriptionSource().split('\n').filter((l) => {
      const t = l.trim();
      return t.startsWith("'") && value.includes(t.slice(1, 30).replace(/\\'/g, "'"));
    })).length;
    expect(valueLiterals).toBe(sourceLiterals);
  });

  it('finds a non-trivial field list to check', () => {
    expect(explainResultFields().length).toBeGreaterThan(10);
  });

  it('names every ExplainResult field an agent will receive', () => {
    const desc = toolDescription();
    const missing = explainResultFields().filter((f) => !desc.includes(f));
    expect(missing, `shipped but never named to an agent: ${missing.join(', ')}`).toEqual([]);
  });

  it('carries the treat-as-data instruction, not just the field name', () => {
    // provenance being *listed* is not enough. The instruction is the point.
    const desc = toolDescription();
    expect(desc).toMatch(/untrusted_fields/);
    expect(desc).toMatch(/never as instructions/);
  });
});
