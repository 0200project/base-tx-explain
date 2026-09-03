import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * THE OLD-DATA / NEW-CODE BOUNDARY, which is where optional fields always break.
 *
 * `cap` and `internal` were added to PassEntry on 2026-09-03. Every other test mints its
 * passes in memory with the CURRENT code, so every pass in them already has the new shape.
 * That leaves the real risk unasserted: **a pass written to disk BEFORE the change and
 * loaded after it.**
 *
 * Two ways that bites, both silent:
 *
 *  - `entry.calls_used >= entry.cap` where `cap` is absent evaluates against `undefined`,
 *    which is ALWAYS false — so every pre-existing pass would run UNCAPPED, in production,
 *    while every test on freshly-minted passes stayed green. The `?? PASS_CALL_CAP` fallback
 *    is what prevents it, and until this file existed nothing failed if someone removed it.
 *  - `internal` absent must mean "a real customer's pass", so a legacy entry must still be
 *    COUNTED by passSnapshot(). An exclusion that defaulted the wrong way would erase real
 *    sales from the metric.
 *
 * Found by Security reviewing the tests rather than the code, after this seat disclosed that
 * the `??` idiom had been written by habit rather than by reasoning about disk state.
 */

// Must be set, and the file written, BEFORE the module reads DATA_DIR at import.
const dir = mkdtempSync(join(tmpdir(), 'btx-pass-legacy-'));
process.env.DATA_DIR = dir;

/** Mirrors passes.ts `hashToken` — the store is keyed by hash, never plaintext. */
const LEGACY_TOKEN = 'btxp_legacyfixture000000000000000000000000000000';
const key = createHash('sha256').update(`btx-pass:${LEGACY_TOKEN}`).digest('hex');

// A pass exactly as the PREVIOUS version of the code would have serialised it:
// no `cap`, no `internal`. Do not add fields here — the absence IS the fixture.
writeFileSync(
  join(dir, 'passes.json'),
  JSON.stringify({
    [key]: {
      issued: Date.now() - 86_400_000,
      expires: Date.now() + 20 * 86_400_000,
      calls_used: 0,
      payer: '0xlegacycustomer',
      active: true,
    },
  }),
);

const { initPasses, usePass, passSnapshot, PASS_CALL_CAP } = await import('../src/passes.js');

describe('a pass serialised before `cap`/`internal` existed', () => {
  it('loads, and is capped at PASS_CALL_CAP rather than running uncapped', () => {
    initPasses();
    const first = usePass(LEGACY_TOKEN);
    expect(first.ok).toBe(true);
    // The whole point: `undefined` must not become "no limit".
    expect(first).toMatchObject({ remaining: PASS_CALL_CAP - 1 });
  });

  it('is COUNTED as a real pass, because absent `internal` means a customer bought it', () => {
    expect(passSnapshot().active_passes).toBe(1);
  });
});
