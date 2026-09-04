import { describe, expect, it } from 'vitest';
import { publicHealthLifetime } from '../src/usage.js';

/**
 * /healthz published `calls: 1319` while 397 of those calls were our own
 * traffic, and `internal_calls` — the field that discloses it — was filtered
 * out of the same response by this allowlist. The public number included us and
 * the correction did not.
 *
 * These are PRESENCE tests on purpose. The obvious guard here would assert that
 * commercial fields stay hidden, and that guard is satisfied most cheaply by
 * removing these three from the allowlist — which restores the exact defect.
 * A rule whose laziest compliance recreates the bug is pointed the wrong way.
 */
describe('the usage total ships with its own divisor', () => {
  const full = {
    calls: 1319,
    internal_calls: 397,
    unmarked_calls: 101,
    free: 752,
    wall_hits: 81,
    degraded_calls: 0,
    revenue_usd: 18.06,
    revenue_from_customers_usd: 0.02,
  };

  it('publishes internal_calls beside calls', () => {
    const pub = publicHealthLifetime(full);
    expect(pub).toHaveProperty('calls');
    expect(pub).toHaveProperty('internal_calls');
  });

  it('publishes unmarked_calls, without which the pair reads as a partition and is not one', () => {
    // calls - internal_calls = 922, but only 821 are external: 101 rows predate
    // the marker and are neither. Two honest numbers, one wrong subtraction.
    const pub = publicHealthLifetime(full);
    expect(pub).toHaveProperty('unmarked_calls');
    expect(Number(pub.calls) - Number(pub.internal_calls) - Number(pub.unmarked_calls)).toBe(821);
  });

  it('still withholds every commercial field', () => {
    const pub = publicHealthLifetime(full);
    expect(pub).not.toHaveProperty('revenue_usd');
    expect(pub).not.toHaveProperty('revenue_from_customers_usd');
  });
});
