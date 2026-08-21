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
  /**
   * Checks the X-BTX-Pass header and consumes one pass call when valid.
   * Runs BEFORE the free tier so a pass holder never burns free calls they
   * paid to skip. Returns the token when the pass covered the call.
   */
  tryPass: (req: express.Request) => string | null;
  /** Give a pass call back when the failure was ours. */
  refundPassUse: (token: string) => void;
  /** Called for every completed request so the usage ledger stays whole. */
  record: (req: express.Request, charged: boolean, ok: boolean, viaPass?: boolean) => void;
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

  // Pass first (a pass holder must never burn the free tier they paid to
  // skip), then free calls, then the payment gate. Mirrors how the MCP path
  // chooses between the free and paid handlers, so the rails cannot drift.
  const gate: express.RequestHandler = (req, res, next) => {
    const passToken = deps.tryPass(req);
    if (passToken) {
      (req as express.Request & { btxPass?: string }).btxPass = passToken;
      next();
      return;
    }
    if (deps.tryFreeCall(req)) {
      (req as express.Request & { btxFree?: boolean }).btxFree = true;
      next();
      return;
    }
    void payGate(req, res, next);
  };

  const handler: express.RequestHandler = async (req, res) => {
    const passToken = (req as express.Request & { btxPass?: string }).btxPass;
    const free = Boolean((req as express.Request & { btxFree?: boolean }).btxFree);
    const body = (req.body ?? {}) as { tx_hash?: unknown };
    const raw = typeof body.tx_hash === 'string' ? body.tx_hash.trim() : '';

    if (!HASH_RE.test(raw)) {
      // Refund a bad request: a typo is the caller's mistake, but charging a
      // free call for input we rejected before doing any work is petty, and
      // the paid rail already refuses to settle on errors.
      if (free) deps.refundFreeCall(req);
      if (passToken) deps.refundPassUse(passToken);
      deps.record(req, false, false, Boolean(passToken));
      res.status(400).json({
        error: 'tx_hash must be a 66-character hex transaction hash (0x + 64 hex chars).',
        code: 'invalid_hash',
      });
      return;
    }

    try {
      const result = await explainTransaction(raw);
      deps.record(req, !free && !passToken, true, Boolean(passToken));
      res.status(200).json(result);
    } catch (err) {
      const known = err instanceof ExplainError;
      if (!known || err.code === 'upstream_error') {
        if (free) deps.refundFreeCall(req);
        if (passToken) deps.refundPassUse(passToken);
      }
      deps.record(req, false, false, Boolean(passToken));
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

export interface PassRouteDeps {
  resourceServer: x402ResourceServer;
  payTo: string;
  priceUsd: string;
  network: `${string}:${string}`;
  publicUrl: string;
  callCap: number;
  days: number;
  mint: () => { token: string; expires_at: string; call_cap: number };
  /** Drop a pass whose payment did not settle (the caller never received it). */
  revoke: (token: string) => void;
  /** Record the $9 settlement in the usage ledger. Only on a confirmed sale. */
  recordSale: () => void;
}

/**
 * POST /pass: buy a 30-day pass over the standard x402 HTTP flow. Deliberately
 * NOT behind the free tier - nobody gets a free $9 pass - so every request
 * goes through its own payment gate against the same resource server.
 */
export function registerPassRoutes(app: express.Express, deps: PassRouteDeps): void {
  const { resourceServer, payTo, priceUsd, network, publicUrl, callCap, days } = deps;

  const passGate = paymentMiddleware(
    {
      'POST /pass': {
        accepts: { scheme: 'exact', network, payTo, price: `$${priceUsd}` },
        resource: `${publicUrl}/pass`,
        description:
          `${days}-day pass for base-tx-explain: up to ${callCap.toLocaleString('en-US')} explain_transaction calls, no account. ` +
          'Returns a bearer token; present it as the X-BTX-Pass header on POST /explain or at _meta["btx/pass"] on MCP calls. ' +
          'Renew by buying a new pass when it expires.',
        mimeType: 'application/json',
        serviceName: 'base-tx-explain',
        tags: ['base', 'transaction', 'decoder', 'pass', 'subscription'],
        unpaidResponseBody: () => ({
          contentType: 'application/json',
          body: {
            error: 'Payment required',
            price_usd: priceUsd,
            what_you_get: `${callCap.toLocaleString('en-US')} calls over ${days} days, rate-limited, transferable bearer token. Lost token = lost pass; there are no accounts.`,
            how: 'This endpoint speaks x402. Pay the quoted amount and retry with the payment attached, or use an x402-capable HTTP client.',
            per_call_alternative: `POST ${publicUrl}/explain at $0.02/call if you would rather pay as you go.`,
          },
        }),
      },
    },
    resourceServer,
  );

  app.post('/pass', passGate, (_req, res) => {
    const pass = deps.mint();
    // The handler runs BEFORE settlement, so at this point we do not yet know
    // whether the $9 moved. The middleware buffers this response and either
    // replays it verbatim (settled) or discards the body and sends its own
    // failure status (did not settle), so the FINAL status is a precise signal
    // — no age heuristic, which would eventually reap a real buyer's unused
    // pass. Book the sale only on a delivered success; otherwise the caller
    // never received this token, so drop it rather than leave it active and
    // inflate the pass count.
    let resolved = false;
    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      if (res.statusCode >= 200 && res.statusCode < 300) {
        deps.recordSale();
        return;
      }
      deps.revoke(pass.token);
      console.error(`[pass] REST sale not settled (status ${res.statusCode}); pass dropped, no revenue booked`);
    };
    res.on('finish', finish);
    // A dropped connection never delivered the token, so it is worthless to the
    // caller either way; do not leave it counted as an active pass.
    res.on('close', finish);
    res.status(200).json({
      pass_token: pass.token,
      expires_at: pass.expires_at,
      call_cap: pass.call_cap,
      how_to_use: {
        rest: `POST ${publicUrl}/explain with header "X-BTX-Pass: ${pass.token}"`,
        mcp: 'attach the token at _meta["btx/pass"] on tools/call',
      },
      keep_this_token: 'This is a bearer pass. It is the only proof of purchase; store it now.',
    });
  });

  app.get('/pass', (_req, res) => {
    res.status(405).json({
      error: 'Use POST.',
      price_usd: priceUsd,
      what_you_get: `${callCap.toLocaleString('en-US')} calls over ${days} days, no account.`,
      example: `curl -X POST ${publicUrl}/pass (x402 payment required; an x402-capable client handles it automatically)`,
    });
  });
}
