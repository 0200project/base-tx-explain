import { describe, expect, it } from 'vitest';
import { clientKey } from '../src/clientKey.js';

/**
 * The property that matters: two addresses a single client can freely choose
 * between must produce the SAME key, and addresses belonging to different
 * clients must not. On IPv6 the former means the whole /64 — the smallest
 * routed allocation, which any VPS or home line controls in full.
 */
describe('clientKey — IPv6 rotation within one allocation is one client', () => {
  it('collapses every address in a /64 to one key', () => {
    const base = '2001:db8:abcd:1234';
    const rotated = [
      `${base}:0:0:0:1`,
      `${base}:aaaa:bbbb:cccc:dddd`,
      `${base}:ffff:ffff:ffff:ffff`,
      `${base}::1`,
      `${base}::`,
    ].map(clientKey);

    expect(new Set(rotated).size).toBe(1);
    expect(rotated[0]).toBe('2001:db8:abcd:1234::/64');
  });

  it('keeps DIFFERENT /64s apart — this must not merge unrelated strangers', () => {
    expect(clientKey('2001:db8:abcd:1234::1')).not.toBe(clientKey('2001:db8:abcd:1235::1'));
    expect(clientKey('2001:db8:abcd:1234::1')).not.toBe(clientKey('2001:db8:abce:1234::1'));
  });

  it('normalises equivalent spellings of the same address', () => {
    // Leading zeros, case, and compression are formatting, not identity.
    const forms = [
      '2001:0DB8:0000:0001:0000:0000:0000:0001',
      '2001:db8:0:1::1',
      '2001:db8:0000:0001::1',
    ].map(clientKey);
    expect(new Set(forms).size).toBe(1);
    expect(forms[0]).toBe('2001:db8:0:1::/64');
  });

  it('ignores bracket form and zone index', () => {
    expect(clientKey('[2001:db8:abcd:1234::1]')).toBe('2001:db8:abcd:1234::/64');
    expect(clientKey('2001:db8:abcd:1234::1%eth0')).toBe('2001:db8:abcd:1234::/64');
  });
});

describe('clientKey — IPv4 stays exact', () => {
  it('does not coarsen IPv4, where one address is one client', () => {
    expect(clientKey('203.0.113.7')).toBe('203.0.113.7');
    // Neighbours in the same /24 are unrelated people and must stay separate.
    expect(clientKey('203.0.113.7')).not.toBe(clientKey('203.0.113.8'));
  });

  it('treats IPv4-mapped IPv6 as the IPv4 client it is', () => {
    expect(clientKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('::FFFF:203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('::203.0.113.7')).toBe('203.0.113.7');
    // and therefore shares a bucket with the plain form, not a second free tier
    expect(clientKey('::ffff:203.0.113.7')).toBe(clientKey('203.0.113.7'));
  });
});

describe('clientKey — degrades safely', () => {
  it('returns a stable key for missing input rather than throwing', () => {
    expect(clientKey(undefined)).toBe('unknown');
    expect(clientKey(null)).toBe('unknown');
    expect(clientKey('')).toBe('unknown');
    expect(clientKey('   ')).toBe('unknown');
  });

  it('leaves an unparseable address alone instead of coarsening it', () => {
    // Merging addresses we do not understand would put unrelated strangers in
    // one bucket, which loses the signal the counts exist to provide.
    expect(clientKey('2001:db8:::1')).toBe('2001:db8:::1');
    expect(clientKey('not-an-ip')).toBe('not-an-ip');
    expect(clientKey('2001:db8:1:2:3:4:5:6:7:8')).toBe('2001:db8:1:2:3:4:5:6:7:8');
  });

  it('handles loopback and unspecified without special-casing', () => {
    expect(clientKey('::1')).toBe('0:0:0:0::/64');
    expect(clientKey('127.0.0.1')).toBe('127.0.0.1');
  });
});
