import { passUrl } from './passUrl.js';
import { paymentMiddleware } from '@x402/express';
import type { x402ResourceServer } from '@x402/core/server';
import type express from 'express';
import { ExplainError, explainTransaction } from './explain.js';
import type { Engagement } from './engagements.js';
import { isEngagementSettled, markEngagementSettled } from './settledEngagements.js';

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
  /** The marketing site. Where a HUMAN goes to buy; publicUrl is the API. */
  siteUrl: string;
  /** Pass terms, so the paywall can offer the cheaper option instead of only the dearer one. */
  passPriceUsd: string;
  passDays: number;
  passCallCap: number;
  /** How many calls a new client gets before this wall. Stated, not implied. */
  freeCalls: number;
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
  const { resourceServer, payTo, priceUsd, network, publicUrl, siteUrl, passPriceUsd, passDays, passCallCap, freeCalls } = deps;

  const payGate = paymentMiddleware(
    {
      'POST /explain': {
        accepts: { scheme: 'exact', network, payTo, price: `$${priceUsd}` },
        resource: `${publicUrl}/explain`,
        description:
          'Explain a Base mainnet transaction in plain English. POST {"tx_hash":"0x..."} and receive strict JSON: summary, action type, assets moved, labeled counterparties, risk flags, gas in USD. Deterministic decode, no LLM in the response path.',
        mimeType: 'application/json',
        serviceName: 'base-transaction-decoder',
        tags: ['base', 'transaction', 'decoder', 'blockchain', 'risk'],
        // What an unpaid caller sees. Standard clients read the 402 headers,
        // but a human with curl gets something they can act on.
        // THE HIGHEST-INTENT MOMENT IN THE FUNNEL, and it used to be a dead end
        // for anyone without a wallet.
        //
        // Whoever reads this tried the product, liked it enough to spend all
        // their free calls, and wants more. That is the closest thing we have to
        // a buyer. The previous body described the x402 flow, never mentioned
        // the pass, offered no URL a person could click, and pointed `docs` at
        // openapi.json — a machine-readable spec handed to a human asking how to
        // pay. The comment above it already claimed a human "gets something they
        // can act on"; it did not.
        //
        // So: both audiences, explicitly. An agent gets the x402 instruction and
        // the spec. A person gets the pass, a card option, and a link. The card
        // rail is the one proven end-to-end under the current configuration, so
        // it is named rather than left implicit.
        unpaidResponseBody: () => ({
          contentType: 'application/json',
          body: {
            error: 'Payment required',
            // "YOU HAVE USED YOURS" WAS A LIE TO THE PERSON MOST LIKELY TO READ IT.
            //
            // The free tier is keyed on IP address, so everyone behind one
            // address shares an allowance. The founder's brother hit this wall
            // on his FIRST EVER call, having used nothing, because a phone on
            // the same WiFi had spent the lot. Telling that person "you have
            // used yours" is false, and it is false in the direction that makes
            // us look broken rather than limited — they have no way to know a
            // colleague or a carrier NAT is the reason.
            //
            // We cannot tell the two apart from here, so the copy must not
            // claim to. It says what is actually true — this address is out —
            // and names the reason they might not recognise, and when it lifts.
            free_tier:
              `The first ${freeCalls} calls from each IP address are free, and this address has used them. ` +
              'If you have not called us before, someone sharing your IP address, office network, VPN ' +
              'or mobile carrier likely has. The allowance resets within 24 hours.',
            price_usd: priceUsd,
            pay_per_call: `This endpoint speaks x402: pay $${priceUsd} in USDC on Base and retry with the payment attached, or use an x402-capable HTTP client which does it automatically.`,
            pass: `Better value for repeated use: $${passPriceUsd} buys ${passDays} days and up to ${passCallCap.toLocaleString('en-US')} calls with no per-call payment. POST ${publicUrl}/pass over x402, or pay by card.`,
            buy_with_card: `${siteUrl}/pricing/`,
            // THE ONLY MOMENT A HIGH-INTENT VISITOR IS STILL LISTENING.
            //
            // Five distinct clients have reached this wall and every one of them
            // vanished, because pay-or-leave were the only options on offer. One of
            // them had made 94 calls and attached a payment four times before giving
            // up — the most interested party in this company's history, and we
            // captured no way to reach them. That is the cheapest thing we were
            // throwing away: not traffic, which is scarce, but the intent of people
            // who already found us and already wanted more.
            //
            // Deliberately not a marketing line. It offers the three things somebody
            // at a paywall actually has — a quota that does not fit, a question, or a
            // company that needs an invoice rather than a card — and it names a
            // mailbox that is verified to reach a human (contact@ routes to the
            // founder's inbox, same verified Cloudflare route as security@).
            talk_to_us:
              'Need a bigger quota, an invoice instead of a card, or something this does not do yet? ' +
              'Email contact@0200project.com and a person will read it.',
            docs: `${siteUrl}/docs/`,
            openapi: `${publicUrl}/openapi.json`,
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
  /** Where a human is sent to pay by card, which the x402 rail cannot serve. */
  siteUrl: string;
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
  const { resourceServer, payTo, priceUsd, network, publicUrl, siteUrl, callCap, days } = deps;

  const passGate = paymentMiddleware(
    {
      'POST /pass': {
        accepts: { scheme: 'exact', network, payTo, price: `$${priceUsd}` },
        resource: `${publicUrl}/pass`,
        description:
          `${days}-day pass for base-transaction-decoder: up to ${callCap.toLocaleString('en-US')} explain_transaction calls, no account. ` +
          'Returns a bearer token; present it as the X-BTX-Pass header on POST /explain or at _meta["btx/pass"] on MCP calls. ' +
          'Renew by buying a new pass when it expires.',
        mimeType: 'application/json',
        serviceName: 'base-transaction-decoder',
        tags: ['base', 'transaction', 'decoder', 'pass', 'subscription'],
        unpaidResponseBody: () => ({
          contentType: 'application/json',
          body: {
            error: 'Payment required',
            price_usd: priceUsd,
            what_you_get: `${callCap.toLocaleString('en-US')} calls over ${days} days, rate-limited, transferable bearer token. Lost token = lost pass; there are no accounts.`,
            how: 'This endpoint speaks x402. Pay the quoted amount and retry with the payment attached, or use an x402-capable HTTP client.',
            per_call_alternative: `POST ${publicUrl}/explain at $0.02/call if you would rather pay as you go.`,
            // A PERSON IN A BROWSER CANNOT RELIABLY PAY THE x402 WAY, AND WE KNEW
            // IT WITHOUT SAYING IT HERE.
            //
            // MetaMask shows a red Blockaid warning on this signature -- "a third
            // party known for scams might take all your assets" -- at the exact
            // moment of confirmation. The founder reported it as a false positive
            // days ago and got no reply, so it is not a lever we control.
            //
            // Blockaid lives in a wallet UI, so an agent signing EIP-712 in code
            // never sees it and a card buyer never sees it. It blocks exactly one
            // path: a human paying x402 in a browser wallet. Our arrivals are 7
            // browsers and 2 CLIs and zero MCP clients, so that is the path
            // essentially all of our traffic is on, and the $9 wall was offering
            // it as the only way to pay.
            //
            // /explain has offered `buy_with_card` all along. The bigger purchase
            // did not. We cannot fix the warning; we can stop walking people into
            // it.
            buy_with_card: `${siteUrl}/pricing/`,
            // THE ONLY MOMENT A HIGH-INTENT VISITOR IS STILL LISTENING.
            //
            // Five distinct clients have reached this wall and every one of them
            // vanished, because pay-or-leave were the only options on offer. One of
            // them had made 94 calls and attached a payment four times before giving
            // up — the most interested party in this company's history, and we
            // captured no way to reach them. That is the cheapest thing we were
            // throwing away: not traffic, which is scarce, but the intent of people
            // who already found us and already wanted more.
            //
            // Deliberately not a marketing line. It offers the three things somebody
            // at a paywall actually has — a quota that does not fit, a question, or a
            // company that needs an invoice rather than a card — and it names a
            // mailbox that is verified to reach a human (contact@ routes to the
            // founder's inbox, same verified Cloudflare route as security@).
            talk_to_us:
              'Need a bigger quota, an invoice instead of a card, or something this does not do yet? ' +
              'Email contact@0200project.com and a person will read it.',

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
      mcp_url: passUrl(publicUrl, pass.token),
      pass_token: pass.token,
      expires_at: pass.expires_at,
      call_cap: pass.call_cap,
      how_to_use: {
        // Same order as every other purchase path: the URL first, because it is
        // the only form that works in clients with a single URL field.
        url: 'Use mcp_url as the server URL in any MCP client. That is the whole setup.',
        rest: `or POST ${publicUrl}/explain with "Authorization: Bearer ${pass.token}"`,
        mcp: 'or attach the token at _meta["btx/pass"] on tools/call',
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

export interface EngagementRouteDeps {
  resourceServer: x402ResourceServer;
  payTo: string;
  network: `${string}:${string}`;
  publicUrl: string;
  /** Where a human pays by card / asks for a formal invoice when x402 is not their rail. */
  siteUrl: string;
  /** The committed engagements to expose, each at its own custom amount. */
  engagements: Engagement[];
  /**
   * Book a settled engagement sale — called ONLY on a delivered success, so it
   * must never be invoked for an attempt that did not settle. Tagged to the id
   * so service revenue stays separable from product revenue.
   */
  recordSale: (engagement: Engagement) => void;
}

/**
 * POST /engagement/<id>: pay a quoted engagement amount over the same x402 flow
 * the product uses, at a CUSTOM price per deal. One route per committed
 * engagement; the on-chain settlement transaction is the invoice.
 *
 * Settle-gating is identical to registerPassRoutes and for the identical reason:
 * the @x402/express middleware buffers the handler's body and replays it only on
 * a settled 2xx, discarding it otherwise. So the receipt reaches the buyer only
 * if the money moved, and the sale is booked only then — an unsettled attempt
 * leaves no receipt and no revenue. This is a payment endpoint, deliberately not
 * a service surface: it takes the agreed money and hands back the agreed
 * receipt, nothing more.
 */
export function registerEngagementRoutes(app: express.Express, deps: EngagementRouteDeps): void {
  const { resourceServer, payTo, network, publicUrl, engagements } = deps;

  // One 404 answer, used for BOTH an unknown/malformed id AND a settled one, so
  // a prober cannot distinguish "no such engagement" from "this customer already
  // paid" — which would reopen the confidentiality the opaque slug + no-title
  // wire closes. Byte-identical by construction, not by intent.
  const notFound = (res: express.Response): void => {
    res.status(404).json({
      error: 'No such engagement.',
      how: 'Engagements are issued by 0200project for a specific agreed deal. If you were quoted one, use the exact URL you were given.',
      contact: 'contact@0200project.com',
    });
  };

  for (const engagement of engagements) {
    const routePath = `/engagement/${engagement.id}`;
    const price = `$${engagement.amountUsd}`;
    const gate = paymentMiddleware(
      {
        [`POST ${routePath}`]: {
          // The price is the requirement verbatim — what the buyer signs is
          // exactly what was quoted, no arithmetic between the two.
          accepts: { scheme: 'exact', network, payTo, price },
          resource: `${publicUrl}${routePath}`,
          // NO title or summary on the wire: this challenge is reachable by
          // anyone who guesses the slug, and an engagement named for its buyer
          // would tell a prober who paid whom for how much. The price is
          // unavoidable (it is the payment amount), so slugs are opaque (see
          // engagements.ts) and identity stays off every unpaid surface.
          description: `A private 0200project engagement, priced at ${price}, paid once over x402; the on-chain settlement transaction is the receipt.`,
          mimeType: 'application/json',
          serviceName: '0200project-engagement',
          tags: ['0200project', 'engagement', 'x402', 'invoice'],
          unpaidResponseBody: () => ({
            contentType: 'application/json',
            body: {
              error: 'Payment required',
              // Deliberately no engagement id, title, or summary (see above): the
              // buyer was quoted this link out of band and knows what it is; the
              // wire says only "pay to proceed".
              how: 'This endpoint speaks x402. Pay the quoted amount in USDC on Base and retry with the payment attached, or use an x402-capable HTTP client which does it automatically.',
              the_receipt:
                'The on-chain settlement transaction IS your invoice — publicly verifiable on BaseScan, no separate document issued.',
              // A crypto-native buyer pays here; a buyer who needs a card or a
              // formal invoice against a legal entity should reach a human.
              need_a_card_or_invoice: 'Email contact@0200project.com — a person will read it.',
            },
          }),
        },
      },
      resourceServer,
    );

    // Refuse a SECOND charge on an already-settled engagement, BEFORE the gate
    // can take money. A company's AP system retries by design and the x402 nonce
    // does not stop a fresh authorization; this does. Answered as a 404 identical
    // to an unknown id, so it confirms nothing about a past sale.
    const guardSettled: express.RequestHandler = (_req, res, next) => {
      if (isEngagementSettled(engagement.id)) {
        notFound(res);
        return;
      }
      next();
    };

    app.post(routePath, guardSettled, gate, (_req, res) => {
      let resolved = false;
      const finish = (): void => {
        if (resolved) return;
        resolved = true;
        if (res.statusCode >= 200 && res.statusCode < 300) {
          // MARK settled + persist BEFORE booking, so a crash between the two
          // leaves the engagement closed (no second charge) rather than payable.
          markEngagementSettled(engagement.id);
          deps.recordSale(engagement);
          return;
        }
        console.error(
          `[engagement] ${engagement.id} ($${engagement.amountUsd}) not settled (status ${res.statusCode}); ` +
            'no receipt delivered, no revenue booked',
        );
      };
      res.on('finish', finish);
      res.on('close', finish);
      res.status(200).json({
        receipt: 'paid',
        engagement: engagement.id,
        title: engagement.title,
        amount_usd: engagement.amountUsd,
        network: `Base (${network})`,
        paid_to: payTo,
        the_invoice:
          'This on-chain settlement is the invoice for this engagement. The transaction hash is in the ' +
          'x402 payment-response header of this reply and in your own wallet history; it is publicly ' +
          'verifiable on BaseScan.',
        issued_by: '0200project',
        keep_this: 'The on-chain transaction is your proof of payment; nothing else is issued.',
      });
    });

    app.get(routePath, (_req, res) => {
      // Once settled, 404 like an unknown id so GET cannot confirm a past sale
      // either. Otherwise a generic "use POST" with no title or identity on it.
      if (isEngagementSettled(engagement.id)) {
        notFound(res);
        return;
      }
      res.status(405).json({
        error: 'Use POST.',
        how: `x402 payment required. POST ${publicUrl}${routePath} with an x402-capable client.`,
      });
    });
  }

  // An id we have not committed is not for sale; identical answer to a settled
  // one (above) so a probe can enumerate nothing. Registered after the concrete
  // routes so a defined, unsettled engagement always wins.
  app.all('/engagement/:id', (_req, res) => {
    notFound(res);
  });
}
