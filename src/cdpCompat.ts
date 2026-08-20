import type { FacilitatorClient } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';

/**
 * Repairs payment payloads that omit the required `accepted` field.
 *
 * An x402 v2 PaymentPayload is `{ x402Version, accepted, payload, ... }`, but
 * the MCP payment client (@x402/mcp 2.23) sends
 * `{ x402Version, payload, extensions }` with no `accepted`. Lenient
 * facilitators reconstruct it from the paymentRequirements passed alongside;
 * CDP validates strictly and rejects the whole request:
 *
 *   400 'paymentPayload' is invalid: must match one of [x402V2Pay...]
 *
 * which is why CDP-settled payments (and therefore CDP Bazaar indexing) were
 * impossible while every other facilitator worked.
 *
 * STATUS: this repair alone does NOT make CDP accept the payment - tested
 * against CDP on 2026-08-20 and the 400 was unchanged. So the payload is
 * missing or misshaping something beyond `accepted`, and the SDK truncates
 * CDP's message before the offending field is named. Kept because emitting a
 * spec-shaped payload is correct regardless, but do not read its presence as
 * "CDP works now".
 *
 * SAFETY: `accepted` means "the requirement the payer chose to satisfy". This
 * shim fills it from the requirement the resource server is verifying against,
 * which is only unambiguous while exactly ONE payment option is advertised.
 * If this server ever offers several (multi-chain, multi-asset), delete this
 * shim rather than guess on the payer's behalf — filling in the wrong
 * `accepted` would misreport what was agreed to.
 */
export function withAcceptedFieldRepair(inner: FacilitatorClient): FacilitatorClient {
  const repair = (payload: PaymentPayload, requirements: PaymentRequirements): PaymentPayload => {
    if (payload && typeof payload === 'object' && payload.accepted) return payload;
    return { ...payload, accepted: requirements };
  };

  return {
    verify: (payload, requirements) => inner.verify(repair(payload, requirements), requirements),
    settle: (payload, requirements) => inner.settle(repair(payload, requirements), requirements),
    getSupported: () => inner.getSupported(),
  };
}
