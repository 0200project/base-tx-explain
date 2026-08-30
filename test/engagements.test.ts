import { describe, expect, it } from 'vitest';
import { ENGAGEMENTS, engagementById } from '../src/engagements.js';

describe('engagements registry', () => {
  it('loads without throwing — every id is a valid slug, every amount positive, ids unique', () => {
    // The module runs these invariants at import; reaching here at all means it
    // passed. Assert the shape too so a malformed future entry fails loudly.
    expect(ENGAGEMENTS.length).toBeGreaterThan(0);
    for (const e of ENGAGEMENTS) {
      expect(e.id).toMatch(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/);
      expect(e.amountUsd).toBeGreaterThan(0);
      expect(typeof e.title).toBe('string');
      expect(e.title.length).toBeGreaterThan(0);
    }
    expect(new Set(ENGAGEMENTS.map((e) => e.id)).size).toBe(ENGAGEMENTS.length);
  });

  it('keeps the demo engagement as the standing acceptance-test target', () => {
    const demo = engagementById('demo');
    expect(demo).toBeDefined();
    expect(demo?.amountUsd).toBe(1);
  });

  it('resolves a known id to its engagement', () => {
    const demo = engagementById('demo');
    expect(demo?.id).toBe('demo');
  });

  it('returns undefined for an unknown id rather than throwing', () => {
    expect(engagementById('does-not-exist')).toBeUndefined();
  });

  it('rejects malformed ids — the id comes straight off the URL path', () => {
    // These must NOT resolve, and (paired with the route 404) must be
    // indistinguishable from a merely-unknown id so nothing can be enumerated
    // or smuggled through the path.
    for (const bad of [
      undefined,
      '',
      'Demo', // uppercase
      'demo/', // trailing slash
      '../demo', // traversal
      'de mo', // space
      'a', // too short for the slug bound
      '-demo', // leading hyphen
      'demo-', // trailing hyphen
      'demo.id', // dot
      'demo%2f', // encoded slash
    ]) {
      expect(engagementById(bad as string | undefined)).toBeUndefined();
    }
  });
});
