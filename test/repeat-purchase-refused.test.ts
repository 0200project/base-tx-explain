import { describe, expect, it } from 'vitest';
import { publicHealthLifetime } from '../src/usage.js';

/**
 * `guardSettled` answers a repeat purchase with the SAME 404 an unknown id
 * gets, so a prober cannot tell "no such engagement" from "already sold". That
 * outward behaviour is unchanged and must stay unchanged.
 *
 * What changed is the inward record. The refusal was previously invisible: the
 * one event meaning "a paying customer tried to pay us again" was, in our own
 * ledger, byte-identical to a stranger guessing a URL. These tests hold the two
 * halves apart — recorded inside, invisible outside.
 */
describe('a refused repeat purchase is recorded inside and withheld outside', () => {
  it('the count never reaches the public endpoint', () => {
    // A non-zero count would tell an anonymous reader that SOME engagement has
    // been sold — exactly the fact the identical-404 withholds. Leaking it on
    // /healthz would undo the guard by another door.
    const pub = publicHealthLifetime({
      calls: 10,
      free: 5,
      wall_hits: 1,
      degraded_calls: 0,
      repeat_purchases_refused: 4,
    });
    expect(pub).not.toHaveProperty('repeat_purchases_refused');
    expect(Object.keys(pub).sort()).toEqual(['calls', 'degraded_calls', 'free', 'wall_hits']);
  });
});
