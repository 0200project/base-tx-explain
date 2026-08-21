import { describe, expect, it } from 'vitest';
import { coercePayment, normalizeMcpPayments } from '../src/mcpPayment.js';

/**
 * The in-band MCP payment path.
 *
 * The defect these tests exist for was reported by the first external party
 * ever to send a real funded payment through this path: a payment presented as
 * base64 — the encoding our OWN HTTP face uses — was silently rejected,
 * producing the same errored result as never having paid. The payer believes
 * they paid, the server behaves as though they did not, and nothing in the
 * response distinguishes the two. Their words: "a client cannot debug it
 * without a second implementation to compare against."
 *
 * A stranger hitting that does not file a bug. They leave.
 */

const PAYMENT = {
  x402Version: 2,
  accepted: { scheme: 'exact', network: 'eip155:8453', amount: '20000' },
  payload: { signature: '0xabc', authorization: { from: '0x1', to: '0x2', value: '20000' } },
};

const msg = (meta?: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'explain_transaction', arguments: { tx_hash: '0x' + 'a'.repeat(64) }, ...(meta ? { _meta: meta } : {}) },
});

const paymentIn = (m: unknown) =>
  (m as { params?: { _meta?: Record<string, unknown> } })?.params?._meta?.['x402/payment'];

describe('coercePayment', () => {
  it('passes an object through unchanged', () => {
    expect(coercePayment(PAYMENT)).toBe(PAYMENT);
  });

  it('accepts JSON', () => {
    expect(coercePayment(JSON.stringify(PAYMENT))).toEqual(PAYMENT);
  });

  it('accepts base64 — the case that was silently failing', () => {
    // This is the encoding our own PAYMENT-REQUIRED header uses, so it is the
    // form a payer is most likely to copy across from the other half of our API.
    const b64 = Buffer.from(JSON.stringify(PAYMENT)).toString('base64');
    expect(coercePayment(b64)).toEqual(PAYMENT);
  });

  it('rejects base64 that decodes to something other than JSON', () => {
    // Guard against treating arbitrary base64 as a payment.
    expect(coercePayment(Buffer.from('not json at all').toString('base64'))).toBeNull();
  });

  it('rejects values that are not payments', () => {
    for (const bad of ['', 'hello', '[]', '"str"', null, undefined, 42, []]) {
      expect(coercePayment(bad)).toBeNull();
    }
  });
});

describe('normalizeMcpPayments', () => {
  it('rewrites a base64 payment into the object form the wrapper reads', () => {
    const body = msg({ 'x402/payment': Buffer.from(JSON.stringify(PAYMENT)).toString('base64') });
    const r = normalizeMcpPayments(body, {});
    expect(r.normalized).toBe(true);
    expect(paymentIn(body)).toEqual(PAYMENT);
  });

  it('leaves an already-correct object untouched and reports no change', () => {
    const body = msg({ 'x402/payment': PAYMENT });
    const r = normalizeMcpPayments(body, {});
    expect(r.normalized).toBe(false);
    expect(paymentIn(body)).toBe(PAYMENT);
  });

  it('lifts an X-PAYMENT header into _meta', () => {
    // A client that knows the HTTP x402 flow and points it at /mcp used to get
    // the challenge back with no explanation, because nothing read that header.
    const body = msg();
    const r = normalizeMcpPayments(body, {
      'x-payment': Buffer.from(JSON.stringify(PAYMENT)).toString('base64'),
    });
    expect(r.normalized).toBe(true);
    expect(r.fromHeader).toBe(true);
    expect(paymentIn(body)).toEqual(PAYMENT);
  });

  it('does not let a header override a payment already in _meta', () => {
    // The in-band value is the more specific expression of intent.
    const other = { ...PAYMENT, x402Version: 99 };
    const body = msg({ 'x402/payment': PAYMENT });
    normalizeMcpPayments(body, { 'x-payment': JSON.stringify(other) });
    expect(paymentIn(body)).toBe(PAYMENT);
  });

  it('leaves an unreadable payment exactly as presented', () => {
    // Deleting it would recreate the silent failure somewhere new: the wrapper
    // should reject a malformed payment loudly, not receive nothing.
    const body = msg({ 'x402/payment': 'garbage-not-a-payment' });
    const r = normalizeMcpPayments(body, {});
    expect(r.normalized).toBe(false);
    expect(paymentIn(body)).toBe('garbage-not-a-payment');
  });

  it('handles a batch, normalising each message independently', () => {
    const body = [
      msg({ 'x402/payment': Buffer.from(JSON.stringify(PAYMENT)).toString('base64') }),
      msg({ 'x402/payment': PAYMENT }),
      msg(),
    ];
    normalizeMcpPayments(body, {});
    expect(paymentIn(body[0])).toEqual(PAYMENT);
    expect(paymentIn(body[1])).toBe(PAYMENT);
    expect(paymentIn(body[2])).toBeUndefined();
  });

  it('does not invent a payment when none was presented anywhere', () => {
    const body = msg();
    const r = normalizeMcpPayments(body, {});
    expect(r.normalized).toBe(false);
    expect(paymentIn(body)).toBeUndefined();
  });

  it('survives malformed bodies without throwing', () => {
    for (const bad of [null, undefined, 'string', 42, [], [null], [{}]]) {
      expect(() => normalizeMcpPayments(bad, {})).not.toThrow();
    }
  });
});
