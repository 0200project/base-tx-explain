import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL_CAVEAT, DIRECT, OTHER, _reloadChannels, channelOf, knownChannels } from '../src/channel.js';

/**
 * Channel attribution exists to answer one question — which listing brought a
 * stranger — on a service with six listings and no way to tell whether any of
 * them produced a single client.
 *
 * Every test here guards a property that a counter earlier the same day got
 * wrong: a caller-controlled value treated as fact, a category with nowhere to
 * go landing somewhere flattering, our own traffic wearing a customer's shape,
 * and an instrument that reports "nothing happened" when it is actually just
 * misconfigured.
 */

describe('channelOf', () => {
  beforeEach(() => {
    delete process.env.CHANNELS;
    _reloadChannels();
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('reports DIRECT when no ref is supplied, rather than guessing', () => {
    expect(channelOf(undefined)).toBe(DIRECT);
    expect(channelOf({})).toBe(DIRECT);
    expect(channelOf({ ref: '' })).toBe(DIRECT);
    expect(channelOf({ ref: '   ' })).toBe(DIRECT);
  });

  it('recognises an allowlisted channel', () => {
    expect(channelOf({ ref: 'glama' })).toBe('glama');
    expect(channelOf({ ref: 'apify' })).toBe('apify');
  });

  it('normalises case and surrounding space before matching', () => {
    // A registry that title-cases our URL, or appends a space, must not read as
    // a failed listing. This is a whole class of false negative for free.
    expect(channelOf({ ref: 'Glama' })).toBe('glama');
    expect(channelOf({ ref: '  APIFY  ' })).toBe('apify');
  });

  it('sends an unrecognised ref to OTHER, never to a real channel', () => {
    expect(channelOf({ ref: 'not-a-listing' })).toBe(OTHER);
  });

  it('never returns the caller-supplied string itself', () => {
    // The bucket name is all that may travel onward. `ref` is chosen by the
    // caller, and a caller-controlled string rendered on the founder's
    // dashboard is the token-symbol injection surface on a new rail.
    const hostile = '<script>alert(1)</script>';
    const out = channelOf({ ref: hostile });
    expect(out).toBe(OTHER);
    expect(out).not.toContain('script');
  });

  it('truncates before doing any work, so a huge ref cannot cost us', () => {
    expect(channelOf({ ref: 'a'.repeat(100_000) })).toBe(OTHER);
  });

  it('ignores a non-string ref instead of throwing', () => {
    for (const bad of [42, null, [], {}, true]) {
      expect(channelOf({ ref: bad })).toBe(DIRECT);
    }
  });

  it('accepts the header form as well as the query form', () => {
    expect(channelOf({}, { 'x-btx-ref': 'glama' })).toBe('glama');
  });

  it('prefers the query form when both are present', () => {
    expect(channelOf({ ref: 'apify' }, { 'x-btx-ref': 'glama' })).toBe('apify');
  });

  it('always lands in exactly one bucket, so totals reconcile', () => {
    // Every call must be countable somewhere. A value that could return null
    // would make the channel totals disagree with the call count, and a
    // discrepancy between two of our own numbers is how a night gets lost.
    for (const v of ['', 'glama', 'nonsense', 'A'.repeat(200), '!!!']) {
      expect(typeof channelOf({ ref: v })).toBe('string');
    }
  });
});

describe('the allowlist', () => {
  beforeEach(() => {
    delete process.env.CHANNELS;
    _reloadChannels();
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('falls back to a built-in list when CHANNELS is unset', () => {
    // THE LOAD-BEARING ONE. If an unset variable emptied the allowlist, every
    // arrival would land in `other` and the instrument would report "no listing
    // produced anything" — which is exactly the conclusion it exists to test,
    // reached from a config slip instead of from reality. Same defect as a risk
    // check that emits nothing when it could not run.
    expect(knownChannels().length).toBeGreaterThan(0);
    expect(channelOf({ ref: 'glama' })).toBe('glama');
  });

  it('honours CHANNELS when set, so a listing needs no code change', () => {
    process.env.CHANNELS = 'aegis,newthing';
    _reloadChannels();
    expect(channelOf({ ref: 'newthing' })).toBe('newthing');
    // ...and anything outside the configured set is now OTHER, including
    // defaults that were valid a moment ago. The set is a deliberate decision.
    expect(channelOf({ ref: 'glama' })).toBe(OTHER);
  });

  it('drops malformed entries from CHANNELS rather than trusting them', () => {
    process.env.CHANNELS = 'aegis, ,<bad>,' + 'x'.repeat(80);
    _reloadChannels();
    expect(knownChannels()).toEqual(['aegis']);
  });

  it('cannot be grown by a caller: hostile input never joins the allowlist', () => {
    // The whole reason this is an allowlist and not a cap-and-evict map. With
    // eviction, an attacker flooding distinct values fills the cap and pushes
    // our real channels into the overflow — corrupting the measurement rather
    // than merely bounding memory.
    const before = knownChannels().length;
    for (let i = 0; i < 500; i++) channelOf({ ref: `flood-${i}` });
    expect(knownChannels().length).toBe(before);
  });
});

describe('the caveat', () => {
  it('says the value is self-reported and unverified', () => {
    // Whoever reads the number at 2am reads the number, not the prose. The
    // caveat ships inside the snapshot object for the same reason risk_flags
    // needed checks beside it.
    expect(CHANNEL_CAVEAT).toMatch(/self-reported/i);
    expect(CHANNEL_CAVEAT).toMatch(/not verified|hint, not proof/i);
    expect(CHANNEL_CAVEAT).toMatch(/internal traffic is excluded/i);
  });
});
