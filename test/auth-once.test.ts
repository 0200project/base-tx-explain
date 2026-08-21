import { beforeEach, describe, expect, it } from 'vitest';
import {
  _authOnceSize,
  _resetAuthOnce,
  authKeyOf,
  forgetAuthorization,
  onceByAuthorization,
} from '../src/authOnce.js';

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

const TX_A = '0xaaa1';
const TX_B = '0xbbb2';
/** Unwrap the common case; a conflict in these tests would be a failure. */
async function once<T>(key: string | null, arg: string, work: () => Promise<T>): Promise<T> {
  const r = await onceByAuthorization(key, arg, work);
  if (r.kind !== 'result') throw new Error(`unexpected conflict, bound to ${r.boundTo}`);
  return r.value;
}

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
    const burst = Promise.all(Array.from({ length: 20 }, () => once(key, TX_A, work)));
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

    const first = await once(key, TX_A, work);
    const retry = await once(key, TX_A, work);
    expect(runs).toBe(1);
    expect(retry).toBe(first);
  });

  it('keeps DIFFERENT authorizations independent — two payments are two decodes', async () => {
    let runs = 0;
    const work = async () => ({ decode: ++runs });
    await once(authKeyOf(boundaryCtx(FROM, '0xaa')), TX_A, work);
    await once(authKeyOf(boundaryCtx(FROM, '0xbb')), TX_A, work);
    expect(runs).toBe(2);
  });

  it('never withholds work when the authorization cannot be identified', async () => {
    // Fail open: an unreadable payload must behave exactly as it did before this
    // module existed. Withholding a decode from a payer is the worse error.
    let runs = 0;
    const work = async () => ({ decode: ++runs });
    await once(null, TX_A, work);
    await once(null, TX_A, work);
    expect(runs).toBe(2);
  });
});

/**
 * The dangerous failure of any shared-result cache: answering the question the
 * caller did NOT ask. Sharing is only sound while every caller of one
 * authorization wants the same transaction, so the first call binds it.
 */
describe('onceByAuthorization — an authorization is bound to one transaction', () => {
  it('REFUSES a different tx_hash rather than returning the bound decode', async () => {
    let runs = 0;
    const key = authKeyOf(boundaryCtx());
    const work = async () => ({ decode: `decode-of-${++runs}` });

    await once(key, TX_A, work);
    const second = await onceByAuthorization(key, TX_B, work);

    expect(second.kind).toBe('conflict'); // not TX_A's decode wearing TX_B's name
    if (second.kind === 'conflict') expect(second.boundTo).toBe(TX_A);
    expect(runs).toBe(1); // and refusing costs no upstream work either
  });

  it('refuses the mismatch in a concurrent burst, which is the attack shape', async () => {
    // One authorization, many DIFFERENT hashes fired together: the shape that
    // maximises RPC spend, and the shape a key without the hash would answer
    // wrongly for all but one caller.
    let runs = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => (release = r));
    const work = async () => {
      runs++;
      await gate;
      return { decode: 'bound' };
    };

    const key = authKeyOf(boundaryCtx());
    const burst = Promise.all([
      onceByAuthorization(key, TX_A, work),
      ...Array.from({ length: 10 }, (_, i) => onceByAuthorization(key, `0xdiff${i}`, work)),
    ]);
    release?.();
    const outcomes = await burst;

    expect(runs).toBe(1);
    expect(outcomes[0]?.kind).toBe('result');
    expect(outcomes.slice(1).every((o) => o.kind === 'conflict')).toBe(true);
  });

  it('lets a fresh authorization ask about the transaction another one was refused for', async () => {
    let runs = 0;
    const work = async () => ({ decode: ++runs });
    await once(authKeyOf(boundaryCtx(FROM, '0xaa')), TX_A, work);
    // A second, separately paid authorization is a second purchase and must work.
    await once(authKeyOf(boundaryCtx(FROM, '0xbb')), TX_B, work);
    expect(runs).toBe(2);
  });
});

/**
 * The map must not become a cheaper attack than the one it closes: this runs on
 * a single 256 MB machine, so unbounded retention would turn a cost bug into an
 * availability bug.
 */
describe('onceByAuthorization — retention is bounded', () => {
  it('caps the number of retained authorizations, evicting oldest first', async () => {
    const work = async () => ({ decode: 'x' });
    for (let i = 0; i < 1500; i++) await once(`payer:${i}`, TX_A, work);
    expect(_authOnceSize()).toBeLessThanOrEqual(1000);
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

    await expect(onceByAuthorization(key, TX_A, failing)).rejects.toThrow('upstream down');
    await expect(onceByAuthorization(key, TX_A, failing)).rejects.toThrow('upstream down');
    expect(runs).toBe(2); // the payment never settled; the caller is owed a real attempt
  });

  it('forgetAuthorization releases a retained error result', async () => {
    // An isError decode does not settle, so index.ts evicts it explicitly.
    let runs = 0;
    const key = authKeyOf(boundaryCtx());
    const work = async () => ({ isError: true, run: ++runs });

    await once(key, TX_A, work);
    forgetAuthorization(key);
    await once(key, TX_A, work);
    expect(runs).toBe(2);
  });
});
