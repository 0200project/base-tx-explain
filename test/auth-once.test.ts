import { beforeEach, describe, expect, it } from 'vitest';
import { _resetAuthOnce, authKeyOf, forgetAuthorization, onceByAuthorization } from '../src/authOnce.js';

/**
 * The property under test is cost, not revenue. One signed EIP-3009
 * authorization is not consumed on-chain until it SETTLES, so N copies of it
 * arriving together all pass verify honestly. Without deduplication each copy
 * runs a full decode — trace, receipt, token metadata — so one $0.02 payment
 * buys N times our most expensive upstream resource.
 */
const FROM = '0xAbCdEf0000000000000000000000000000000001';
const NONCE = '0xFEED0000000000000000000000000000000000000000000000000000000000AA';

/** The payload as it reaches the MCP tool boundary, outside the x402 wrapper. */
const boundaryCtx = (from = FROM, nonce = NONCE) => ({
  _meta: { 'x402/payment': { payload: { authorization: { from, to: '0x2', value: '20000', nonce } } } },
});
/** The same payload as the x402 wrapper presents it internally. */
const wrapperCtx = (from = FROM, nonce = NONCE) => ({
  meta: { 'x402/payment': { payload: { authorization: { from, nonce } } } },
});

beforeEach(() => _resetAuthOnce());

describe('authKeyOf — a silent null here would make the whole fix a no-op', () => {
  it('reads the boundary shape (_meta), which is the live one for this call site', () => {
    expect(authKeyOf(boundaryCtx())).toBe(`${FROM.toLowerCase()}:${NONCE.toLowerCase()}`);
  });

  it('also reads the wrapper shape (meta), because confusing the two has cost us an outage before', () => {
    expect(authKeyOf(wrapperCtx())).toBe(`${FROM.toLowerCase()}:${NONCE.toLowerCase()}`);
  });

  it('distinguishes the payer, so two people cannot collide on a reused nonce', () => {
    expect(authKeyOf(boundaryCtx('0xaaa'))).not.toBe(authKeyOf(boundaryCtx('0xbbb')));
  });

  it('returns null for anything it cannot read, rather than guessing', () => {
    expect(authKeyOf(undefined)).toBeNull();
    expect(authKeyOf({})).toBeNull();
    expect(authKeyOf({ _meta: {} })).toBeNull();
    expect(authKeyOf({ _meta: { 'x402/payment': { payload: { authorization: { from: FROM } } } } })).toBeNull();
    expect(authKeyOf({ _meta: { 'x402/payment': { payload: { authorization: { nonce: NONCE } } } } })).toBeNull();
  });
});

describe('onceByAuthorization — one authorization buys exactly one decode', () => {
  it('runs the work ONCE for concurrent copies of one authorization', async () => {
    let runs = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => (release = r));
    const work = async () => {
      runs++;
      await gate; // hold every caller open together, as a real burst would be
      return { decode: 'result', run: runs };
    };

    const key = authKeyOf(boundaryCtx());
    const burst = Promise.all(Array.from({ length: 20 }, () => onceByAuthorization(key, work)));
    release?.();
    const results = await burst;

    expect(runs).toBe(1); // 20 requests, one decode, one set of RPC calls
    expect(new Set(results).size).toBe(1); // and every caller got that same decode
  });

  it('serves a later retry of a settled authorization instead of charging twice or refusing', async () => {
    // A client whose response was lost retries with the same authorization. The
    // money already moved, so the only correct answer is the decode it bought.
    let runs = 0;
    const key = authKeyOf(boundaryCtx());
    const work = async () => ({ decode: ++runs });

    const first = await onceByAuthorization(key, work);
    const retry = await onceByAuthorization(key, work);
    expect(runs).toBe(1);
    expect(retry).toBe(first);
  });

  it('keeps DIFFERENT authorizations independent — two payments are two decodes', async () => {
    let runs = 0;
    const work = async () => ({ decode: ++runs });
    await onceByAuthorization(authKeyOf(boundaryCtx(FROM, '0xaa')), work);
    await onceByAuthorization(authKeyOf(boundaryCtx(FROM, '0xbb')), work);
    expect(runs).toBe(2);
  });

  it('never withholds work when the authorization cannot be identified', async () => {
    // Fail open: an unreadable payload must behave exactly as it did before this
    // module existed. Withholding a decode from a payer is the worse error.
    let runs = 0;
    const work = async () => ({ decode: ++runs });
    await onceByAuthorization(null, work);
    await onceByAuthorization(null, work);
    expect(runs).toBe(2);
  });
});

describe('onceByAuthorization — a failure leaves the authorization unspent', () => {
  it('does not retain a rejection, so a retry really runs', async () => {
    let runs = 0;
    const key = authKeyOf(boundaryCtx());
    const failing = async () => {
      runs++;
      throw new Error('upstream down');
    };

    await expect(onceByAuthorization(key, failing)).rejects.toThrow('upstream down');
    await expect(onceByAuthorization(key, failing)).rejects.toThrow('upstream down');
    expect(runs).toBe(2); // the payment never settled; the caller is owed a real attempt
  });

  it('forgetAuthorization releases a retained error result', async () => {
    // An isError decode does not settle, so index.ts evicts it explicitly.
    let runs = 0;
    const key = authKeyOf(boundaryCtx());
    const work = async () => ({ isError: true, run: ++runs });

    await onceByAuthorization(key, work);
    forgetAuthorization(key);
    await onceByAuthorization(key, work);
    expect(runs).toBe(2);
  });
});
