import { paymentMiddleware } from '@x402/express';
import type { x402ResourceServer } from '@x402/core/server';
import type express from 'express';
import { ExplainError, explainTransaction } from './explain.js';

/**
 * Plain REST access to the same decode the MCP tool serves.
 *
 * The MCP endpoint can only be paid through the MCP envelope, so a generic
 * x402 HTTP client (payfetch, x402-fetch, anything speaking the plain
 * protocol) cannot buy from us at all: even if it paid, it would then face a
 * JSON-RPC body and an SSE response and have gained nothing. This route is the
 * ordinary HTTP resource those clients already know how to consume, and it is
 * what the Bazaar and x402scan catalogs describe when they list an HTTP
 * resource.
 *
 * Same decode, same price, same free tier — only the envelope differs.
 */

export interface RestDeps {
  resourceServer: x402ResourceServer;
  payTo: string;
  priceUsd: string;
  network: `${string}:${string}`;
  publicUrl: string;
  /** Returns true if this caller may have a free call (and consumes it). */
  tryFreeCall: (req: express.Request) => boolean;
  /** Give a free call back when the failure was ours. */
  refundFreeCall: (req: express.Request) => void;
  /** Called for every completed request so the usage ledger stays whole. */
  record: (req: express.Request, charged: boolean, ok: boolean) => void;
}

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export function registerRestRoutes(app: express.Express, deps: RestDeps): void {
  const { resourceServer, payTo, priceUsd, network, publicUrl } = deps;

  const payGate = paymentMiddleware(
    {
      'POST /explain': {
        accepts: { scheme: 'exact', network, payTo, price: `$${priceUsd}` },
        resource: `${publicUrl}/explain`,
        description:
          'Explain a Base mainnet transaction in plain English. POST {"tx_hash":"0x..."} and receive strict JSON: summary, action type, assets moved, labeled counterparties, risk flags, gas in USD. Deterministic decode, no LLM in the response path.',
        mimeType: 'application/json',
        serviceName: 'base-tx-explain',
        tags: ['base', 'transaction', 'decoder', 'blockchain', 'risk'],
        // What an unpaid caller sees. Standard clients read the 402 headers,
        // but a human with curl gets something they can act on.
        unpaidResponseBody: () => ({
          contentType: 'application/json',
          body: {
            error: 'Payment required',
            price_usd: priceUsd,
            how: 'This endpoint speaks x402. Pay the quoted amount and retry with the payment attached, or use an x402-capable HTTP client which does it automatically.',
            free_tier: 'The first calls from a new client are free; you have used yours.',
            docs: `${publicUrl}/openapi.json`,
          },
        }),
      },
    },
    resourceServer,
  );

  // Free calls skip the payment gate entirely; everyone else pays before the
  // handler runs. Mirrors how the MCP path chooses between the free and paid
  // handlers, so the two rails cannot drift on who gets charged.
  const gate: express.RequestHandler = (req, res, next) => {
    if (deps.tryFreeCall(req)) {
      (req as express.Request & { btxFree?: boolean }).btxFree = true;
      next();
      return;
    }
    void payGate(req, res, next);
  };

  const handler: express.RequestHandler = async (req, res) => {
    const free = Boolean((req as express.Request & { btxFree?: boolean }).btxFree);
    const body = (req.body ?? {}) as { tx_hash?: unknown };
    const raw = typeof body.tx_hash === 'string' ? body.tx_hash.trim() : '';

    if (!HASH_RE.test(raw)) {
      // Refund a bad request: a typo is the caller's mistake, but charging a
      // free call for input we rejected before doing any work is petty, and
      // the paid rail already refuses to settle on errors.
      if (free) deps.refundFreeCall(req);
      deps.record(req, false, false);
      res.status(400).json({
        error: 'tx_hash must be a 66-character hex transaction hash (0x + 64 hex chars).',
        code: 'invalid_hash',
      });
      return;
    }

    try {
      const result = await explainTransaction(raw);
      deps.record(req, !free, true);
      res.status(200).json(result);
    } catch (err) {
      const known = err instanceof ExplainError;
      if (free && (!known || err.code === 'upstream_error')) deps.refundFreeCall(req);
      deps.record(req, false, false);
      if (!known) console.error('REST explain failed:', err);
      res.status(known && err.code === 'not_found' ? 404 : known ? 400 : 502).json({
        error: known
          ? err.message
          : 'Internal error while decoding the transaction. Retry once; if it persists the upstream RPC is degraded.',
        code: known ? err.code : 'internal_error',
      });
    }
  };

  app.post('/explain', gate, handler);

  // A GET is what a curious human tries first. Tell them how to use it rather
  // than 404ing, and do not bill anyone for reading the instructions.
  app.get('/explain', (_req, res) => {
    res.status(405).json({
      error: 'Use POST.',
      example: `curl -X POST ${publicUrl}/explain -H 'Content-Type: application/json' -d '{"tx_hash":"0x..."}'`,
      price_usd: priceUsd,
      docs: `${publicUrl}/openapi.json`,
    });
  });
}
