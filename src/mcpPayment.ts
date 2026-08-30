/**
 * Make the in-band MCP payment path forgiving about how a payment arrives.
 *
 * An external party ran the first real funded payment ever to cross this path and
 * reported three usability defects from the payer's side. Two are fixed here.
 *
 * THE EXPENSIVE ONE. The payment at `_meta["x402/payment"]` must be a JSON
 * OBJECT. Send the identical value base64-encoded — which is exactly what our
 * own HTTP face uses, in the PAYMENT-REQUIRED header — and it is silently
 * rejected, producing the same errored result as never having paid at all. In
 * their words: "a client cannot debug it without a second implementation to
 * compare against."
 *
 * That is the worst shape a payment bug can take. The payer believes they paid,
 * the server behaves as though they did not, and nothing in the response tells
 * either side which happened. A stranger hitting it does not file a bug report,
 * they leave. And the encoding they are most likely to reach for is the one WE
 * taught them by using it everywhere else.
 *
 * THE HEADER ONE. x402 over HTTP carries payment in an `X-PAYMENT` header. A
 * client that knows the HTTP flow and points it at the MCP endpoint gets the
 * challenge back again with no explanation, because nothing reads that header
 * here. Same failure mode: a correct-looking request, silently unpaid.
 *
 * The fix for both is to normalise before the payment wrapper ever sees the
 * message, so every reasonable way of presenting a payment converges on the one
 * shape the wrapper accepts. Being liberal about the envelope costs nothing:
 * the SIGNATURE is what authorises the money, and it is verified downstream
 * exactly as before. Nothing here decides whether a payment is valid — it only
 * decides whether the wrapper gets to see it.
 */

const PAYMENT_KEY = 'x402/payment';

/** Shape we hand the wrapper. Contents are the payer's; we never author one. */
type PaymentObject = Record<string, unknown>;

/**
 * Coerce one presented payment into an object, or null if it is not one.
 *
 * Accepts, in order: an object already; a JSON string; a base64-encoded JSON
 * string. The last is the case that was silently failing.
 */
export function coercePayment(value: unknown): PaymentObject | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as PaymentObject;
  }
  if (typeof value !== 'string' || value.length === 0) return null;

  const parsed = tryJson(value);
  if (parsed) return parsed;

  // base64 — the form our own HTTP header uses, so the one a payer is most
  // likely to copy across from the other half of our own API.
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    // Guard against base64 that decodes to noise: only accept real JSON.
    return tryJson(decoded);
  } catch {
    return null;
  }
}

function tryJson(s: string): PaymentObject | null {
  const trimmed = s.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const v = JSON.parse(trimmed) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as PaymentObject) : null;
  } catch {
    return null;
  }
}

/**
 * Rewrite a batch of MCP messages so any presented payment is in the one place
 * and the one shape the payment wrapper reads.
 *
 * Also lifts an `X-PAYMENT` header into `_meta`, so a client that knows the
 * HTTP flow and aims it at the MCP endpoint is paid rather than silently not.
 *
 * Mutates in place because the same object is handed to the transport
 * afterwards, and the point is that the transport sees the normalised form.
 * Returns whether anything was normalised, so the caller can log the case that
 * used to fail silently — a payer who hits it should show up in our logs even
 * though they now succeed.
 */
export function normalizeMcpPayments(
  body: unknown,
  headers: Record<string, unknown>,
): { normalized: boolean; fromHeader: boolean } {
  const messages = Array.isArray(body) ? body : [body];
  let normalized = false;
  let fromHeader = false;

  const headerPayment = coercePayment(headers['x-payment']);

  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const msg = m as { params?: Record<string, unknown> };
    if (!msg.params || typeof msg.params !== 'object') {
      // Only create the container when a header payment needs somewhere to go.
      if (!headerPayment) continue;
      msg.params = {};
    }
    const params = msg.params as Record<string, unknown>;
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    const presented = meta[PAYMENT_KEY];

    if (presented !== undefined) {
      const coerced = coercePayment(presented);
      // A value we cannot read is left exactly as it is: the wrapper should
      // reject a malformed payment, and quietly deleting it would recreate the
      // silent failure in a new place.
      if (coerced && coerced !== presented) {
        meta[PAYMENT_KEY] = coerced;
        params._meta = meta;
        normalized = true;
      }
    } else if (headerPayment) {
      meta[PAYMENT_KEY] = headerPayment;
      params._meta = meta;
      normalized = true;
      fromHeader = true;
    }
  }

  return { normalized, fromHeader };
}
