import { createHash, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createCdpFacilitatorClient } from '@coinbase/cdp-sdk/x402';
import { HTTPFacilitatorClient, x402ResourceServer, type FacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { createPaymentWrapper, type MCPToolContext, type ToolResult } from '@x402/mcp';
import express from 'express';
import * as z from 'zod/v4';
import { dashboardPage, loginPage } from './dashboard.js';
import { ExplainError, explainTransaction } from './explain.js';
import { FAVICON_PNG } from './favicon.js';
import { withAcceptedFieldRepair } from './cdpCompat.js';
import { buildOpenApiDocument } from './openapi.js';
import { registerPassRoutes, registerRestRoutes } from './rest.js';
import { getTreasury } from './treasury.js';
import { consumeFreeCall, initFreeTier, refundFreeCall, withinRateLimit } from './freeTier.js';
import { PASS_CALL_CAP, PASS_DAYS, PASS_PRICE_USD, initPasses, mintPass, passSnapshot, refundPassUse, activatePass, revokePass, revokePendingPass, usePass } from './passes.js';
import { HOUR, TtlCache } from './cache.js';
import { APIFY_BILLING_ACTIVE, initApifyBilling, chargeApifyCall } from './apifyBilling.js';
import { initUsageLedger, recordEvent, usageSnapshot } from './usage.js';

const VERSION = '0.1.2';
const NETWORK = 'eip155:8453' as const; // Base mainnet
const PAYMENT_MODE = process.env.PAYMENT_MODE === 'x402' ? 'x402' : 'none';
const PRICE_USD = process.env.X402_PRICE_USD ?? '0.02';
const PUBLIC_URL = (process.env.PUBLIC_URL ?? 'https://base-tx-explain.fly.dev').replace(/\/$/, '');
const SITE_URL = 'https://0200project.com';

const TOOL_NAME = 'explain_transaction';
const TOOL_DESCRIPTION =
  'Explain a Base-mainnet transaction in plain English. Input: a transaction hash. ' +
  'Returns strict JSON: summary (1-3 sentences), action_type (swap, erc20_transfer, ' +
  'nft_mint, bridge_out, approval_for_all, ...), assets_moved[] (token, amount, from, to), ' +
  'counterparties[] (labeled where known: routers, bridges, marketplaces), risk_flags[] ' +
  '(unverified_contract, unlimited_approval, approval_for_all, known_drainer, ' +
  'first_time_counterparty, nonstandard_token_symbol, impersonated_token, ' +
  'transaction_reverted), checks, gas_paid_usd, timestamp, basescan_url. ' +
  'Risk checks fail open, so read `checks` before drawing any conclusion from an empty ' +
  'risk_flags: it reports whether each check ran (ok / partial / unavailable / not_applicable), ' +
  'and no flags alongside a non-ok status means not checked, not clean. ' +
  'Deterministic onchain decode - no LLM in the response path. Base mainnet (chain id 8453) only.';

const INPUT_SHAPE = {
  tx_hash: z
    .string()
    .describe('The Base mainnet transaction hash to explain (0x + 64 hex characters).'),
};

async function runExplain({ tx_hash }: { tx_hash: string }): Promise<ToolResult> {
  try {
    const result = await explainTransaction(tx_hash);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  } catch (err) {
    const isKnown = err instanceof ExplainError;
    const payload = {
      error: isKnown ? err.message : 'Internal error while decoding the transaction. Retry once; if it persists, the upstream RPC is degraded.',
      code: isKnown ? err.code : 'internal_error',
    };
    if (!isKnown) console.error('explain_transaction failed:', err);
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true };
  }
}

// --- x402 payment plumbing (initialized only in x402 mode) ---
let paidHandler: ((args: { tx_hash: string }, extra: unknown) => Promise<Record<string, unknown>>) | null = null;
let buyPassHandler: ((args: Record<string, never>, extra: unknown) => Promise<Record<string, unknown>>) | null = null;
/**
 * Plain-HTTP 402 body for non-MCP callers. Discovery crawlers (CDP's
 * validator, x402scan's registration probe) send Accept: application/json
 * and expect an HTTP 402 with the x402 payment requirements; the MCP
 * streamable transport would otherwise answer 406 and they give up.
 */
let httpPaymentRequired: Record<string, unknown> | null = null;
/** Shared with the REST rail so both charge through one configured server. */
let sharedResourceServer: import('@x402/core/server').x402ResourceServer | null = null;
let sharedPayTo = '';

// An https resource URL: x402 indexers (Bazaar, x402scan) group and link
// resources by URL and may drop non-https schemes.
const RESOURCE_INFO = {
  url: `${PUBLIC_URL}/mcp`,
  description: TOOL_DESCRIPTION,
  mimeType: 'application/json',
  serviceName: 'base-tx-explain',
  tags: ['base', 'transaction', 'decoder', 'blockchain', 'risk'],
};

const BAZAAR_EXTENSIONS = declareDiscoveryExtension({
  toolName: TOOL_NAME,
  description: TOOL_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: { tx_hash: { type: 'string', description: 'Base mainnet transaction hash (0x + 64 hex chars)' } },
    required: ['tx_hash'],
  },
  example: { tx_hash: '0x' + 'ab'.repeat(32) },
});

/**
 * Did this settlement affirmatively succeed? Used to decide whether to BOOK
 * REVENUE, where the safe default is strictness: never record money we cannot
 * confirm arrived. Under-reporting is always recoverable from the payout wallet
 * on-chain; over-reporting is invisible from inside the ledger.
 *
 * Do NOT reuse this to decide whether to withhold something from a customer.
 * `success: false` does not mean the funds stayed put — see provablyUnpaid.
 */
function settledOk(settlement: unknown): boolean {
  return Boolean(settlement) && (settlement as { success?: unknown }).success === true;
}

/**
 * Settle failures that provably happened BEFORE anything was broadcast, so no
 * funds can have moved. Only these justify taking a pass back.
 *
 * `success: false` on its own does NOT mean the money stayed put:
 * `settlement_pending` carries a real tx hash when the receipt wait timed out
 * after broadcast, and `transfer_event_mismatch` means the transfer MINED and
 * only the log check failed. Revoking on either would rob a customer who paid.
 * The facilitator sets `transaction: ""` only in the catch around the broadcast
 * call, so an empty hash plus one of these validation reasons is the one
 * combination that is safe to act on.
 */
const PRE_BROADCAST_REJECTIONS = new Set([
  'invalid_exact_evm_scheme',
  'invalid_exact_evm_network_mismatch',
  'invalid_exact_evm_missing_eip712_domain',
  'invalid_exact_evm_recipient_mismatch',
  'invalid_exact_evm_signature',
  'invalid_exact_evm_payload_authorization_valid_before',
  'invalid_exact_evm_payload_authorization_valid_after',
  'invalid_exact_evm_authorization_value',
  'invalid_exact_evm_payload_authorization_value_mismatch',
  'invalid_exact_evm_token_name_mismatch',
  'invalid_exact_evm_token_version_mismatch',
  'invalid_exact_evm_eip3009_not_supported',
  'invalid_exact_evm_insufficient_balance',
  'invalid_exact_evm_transaction_simulation_failed',
  'asset_not_deployed_contract',
]);

/** True only when we can prove the payment never left the ground. */
function provablyUnpaid(settlement: unknown): boolean {
  const s = settlement as { success?: unknown; transaction?: unknown; errorReason?: unknown } | undefined;
  if (!s || s.success !== false) return false;
  if (typeof s.transaction === 'string' && s.transaction !== '') return false; // broadcast happened
  return typeof s.errorReason === 'string' && PRE_BROADCAST_REJECTIONS.has(s.errorReason);
}

/** The EIP-3009 authorization nonce identifies one payment across the hooks. */
function authNonceOf(paymentPayload: unknown): string | null {
  const nonce = (paymentPayload as { payload?: { authorization?: { nonce?: unknown } } } | undefined)
    ?.payload?.authorization?.nonce;
  return typeof nonce === 'string' && nonce ? nonce.toLowerCase() : null;
}

async function initPayments(): Promise<void> {
  if (PAYMENT_MODE !== 'x402') return;
  const payTo = process.env.X402_PAY_TO ?? '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo) || /^0x0{40}$/.test(payTo)) {
    throw new Error('PAYMENT_MODE=x402 requires X402_PAY_TO to be set to a real receiving address.');
  }
  // Facilitators verify and settle payments. Catalogs are per-facilitator with
  // no cross-aggregation: a settlement only lists this resource in the catalog
  // of the facilitator that processed it. CDP first (its Bazaar is the catalog
  // agents query, and it indexes only CDP-settled resources), PayAI second as a
  // keyless fallback so payments still work if CDP credentials lapse.
  // ORDER MATTERS AND IS REVENUE-CRITICAL. The resource server routes a payment
  // to the first facilitator supporting the scheme/network and does NOT retry
  // the next one on rejection, so a facilitator that refuses our payloads must
  // never be first.
  //
  // CDP's facilitator rejects the payment payload that @x402/mcp 2.23 clients
  // produce, with 400 "'paymentPayload' is invalid: must match one of
  // [x402V2Pay...]" (message truncated by the SDK). Tested 2026-08-20; the
  // keyless facilitator settles the identical payload. Filling in the missing
  // `accepted` field (see cdpCompat.ts) did NOT resolve it, so the mismatch is
  // deeper than that one field and the full CDP message is needed to go
  // further.
  //
  // Do not put CDP first "just to try": the payload comes from the PAYER's
  // client, so this rejects real strangers' payments too, not just our test
  // client. Until the incompatibility is understood, CDP-first means taking no
  // money at all. X402_PREFER_CDP=1 exists solely for a deliberate, supervised
  // retest with someone watching the logs.
  const facilitators: FacilitatorClient[] = [];
  const facilitatorNames: string[] = [];
  const keylessUrl = process.env.X402_FACILITATOR_URL || 'https://facilitator.payai.network';
  const cdpAvailable = Boolean(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET);
  const preferCdp = process.env.X402_PREFER_CDP === '1';

  if (cdpAvailable && preferCdp) {
    facilitators.push(withAcceptedFieldRepair(createCdpFacilitatorClient()));
    facilitatorNames.push('cdp');
  }
  facilitators.push(new HTTPFacilitatorClient({ url: keylessUrl }));
  facilitatorNames.push(keylessUrl);
  if (cdpAvailable && !preferCdp) {
    facilitators.push(withAcceptedFieldRepair(createCdpFacilitatorClient()));
    facilitatorNames.push('cdp(fallback)');
  }

  const buildResourceServer = (clients: typeof facilitators) => {
    const server = new x402ResourceServer(clients).register(NETWORK, new ExactEvmScheme());
    // Payment-path visibility: a rejected payment must never be silent.
    // Log payment failures whole. A truncated payload is what made the CDP
    // rejection guesswork: scheme/network fell outside the first 600 chars.
    // Signatures and authorization nonces are single-use and already public
    // once submitted, so there is no secret here worth truncating for.
    const logFailure = (label: string) => async (ctx: unknown) => {
      let body: string;
      try {
        body = JSON.stringify(ctx, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
      } catch {
        body = String(ctx);
      }
      console.error(`[x402] ${label}:`, body.slice(0, 8000));
    };
    server.onVerifyFailure(logFailure('VERIFY FAILED')).onSettleFailure(logFailure('SETTLE FAILED'));
    return server;
  };

  // Bad or expired CDP credentials must degrade to the keyless facilitator,
  // never take the paid endpoint down: losing Bazaar indexing is recoverable,
  // a crash-looping revenue server is not.
  let resourceServer = buildResourceServer(facilitators);
  try {
    await resourceServer.initialize();
  } catch (err) {
    const cdpIndex = facilitatorNames.findIndex((n) => n.startsWith('cdp'));
    if (cdpIndex === -1) throw err;
    console.error('[x402] CDP facilitator unavailable, falling back to keyless facilitator:', err);
    facilitators.splice(cdpIndex, 1);
    facilitatorNames.splice(cdpIndex, 1);
    resourceServer = buildResourceServer(facilitators);
    await resourceServer.initialize();
  }
  const accepts = await resourceServer.buildPaymentRequirements({
    scheme: 'exact',
    network: NETWORK,
    payTo,
    price: `$${PRICE_USD}`,
  });
  const paid = createPaymentWrapper(resourceServer, {
    accepts,
    resource: RESOURCE_INFO,
    extensions: BAZAAR_EXTENSIONS,
    hooks: {
      onBeforeExecution: ({ paymentPayload }) => {
        console.log('[x402] payment VERIFIED, executing tool (payer payload present:', Boolean(paymentPayload), ')');
      },
      onAfterSettlement: ({ settlement }) => {
        // The facilitator can answer HTTP 200 with success:false — settlement
        // did not happen. Booking that as revenue corrupts the ledger and hides
        // the loss, so only a confirmed settle is recorded.
        if (!settledOk(settlement)) {
          console.error('[x402] SETTLE NOT CONFIRMED, booking no revenue:', JSON.stringify(settlement).slice(0, 400));
          return;
        }
        console.log('[x402] SETTLED:', JSON.stringify(settlement).slice(0, 400));
        recordEvent({
          t: new Date().toISOString(),
          e: 'settled',
          client: settlement.payer ?? 'unknown',
          amount_usd: Number.parseFloat(PRICE_USD),
          payer: settlement.payer,
          tx: settlement.transaction,
        });
      },
    },
  });
  sharedResourceServer = resourceServer;
  sharedPayTo = payTo;
  paidHandler = paid(runExplain) as typeof paidHandler;

  // The $9 pass tool rides the same resource server with its own price.
  // Mint happens in the handler (post-verify); if settlement then fails we
  // log the loss loudly rather than strand a paying customer - the reverse
  // error (money taken, no pass) is the one we can never allow.
  const passAccepts = await resourceServer.buildPaymentRequirements({
    scheme: 'exact',
    network: NETWORK,
    payTo,
    price: `$${PASS_PRICE_USD}`,
  });
  const paidPass = createPaymentWrapper(resourceServer, {
    accepts: passAccepts,
    resource: {
      url: `${PUBLIC_URL}/pass`,
      description: `${PASS_DAYS}-day pass: up to ${PASS_CALL_CAP.toLocaleString('en-US')} explain_transaction calls for $${PASS_PRICE_USD}. Bearer token, no account.`,
      mimeType: 'application/json',
      serviceName: 'base-tx-explain',
    },
    hooks: {
      onAfterSettlement: ({ settlement, paymentPayload }) => {
        const nonce = authNonceOf(paymentPayload);
        // Only an affirmative pre-broadcast rejection takes the pass back.
        // Every other non-success (settlement_pending with a real tx hash, a
        // mined-but-mismatched transfer, anything unrecognised) may mean the
        // customer's money moved, so the pass is ACTIVATED and the operator is
        // alerted. Withholding on ambiguity is the same $9 theft in a
        // safer-looking shape.
        if (!settledOk(settlement) && !provablyUnpaid(settlement) && nonce) {
          console.error(
            `[pass] $${PASS_PRICE_USD} SETTLE AMBIGUOUS - activating the pass and alerting; funds may have moved. ` +
              `nonce=${nonce} payer=${(settlement as { payer?: string })?.payer ?? 'unknown'} ` +
              `tx=${(settlement as { transaction?: string })?.transaction || 'none'} ` +
              `reason=${(settlement as { errorReason?: string })?.errorReason ?? 'unknown'} ` +
              `detail=${JSON.stringify(settlement).slice(0, 400)}`,
          );
          const why =
            `${(settlement as { errorReason?: string })?.errorReason ?? 'unknown'}` +
            ` tx=${(settlement as { transaction?: string })?.transaction || 'none'}`;
          if (!activatePass(nonce, (settlement as { payer?: string })?.payer, why)) {
            console.error(`[pass] no pending pass matched nonce=${nonce} - manual follow-up needed`);
          }
          return;
        }
        if (!settledOk(settlement)) {
          // No money moved, so the token minted by the handler must never
          // become usable. The caller still receives the string; it buys
          // nothing. Loud, because the rare "settled on-chain but the response
          // was lost" case lands here too and is manually recoverable.
          console.error(
            `[pass] $${PASS_PRICE_USD} SETTLE NOT CONFIRMED - discarding pending pass, booking no revenue. ` +
              `nonce=${nonce ?? 'unknown'} payer=${(settlement as { payer?: string })?.payer ?? 'unknown'} ` +
              `tx=${(settlement as { transaction?: string })?.transaction ?? 'none'} ` +
              `detail=${JSON.stringify(settlement).slice(0, 400)}`,
          );
          if (nonce) revokePendingPass(nonce, 'settlement not confirmed');
          return;
        }
        if (nonce && !activatePass(nonce, settlement.payer)) {
          console.error(`[pass] SETTLED but no pending pass matched nonce=${nonce} - manual follow-up needed`);
        }
        console.log('[pass] $' + PASS_PRICE_USD + ' SETTLED:', JSON.stringify(settlement).slice(0, 400));
        recordEvent({
          t: new Date().toISOString(),
          e: 'settled',
          client: settlement.payer ?? 'unknown',
          amount_usd: Number.parseFloat(PASS_PRICE_USD),
          payer: settlement.payer,
          tx: settlement.transaction,
        });
      },
    },
  });
  // Per call so the minted token is captured without shared mutable state.
  // Wrapper built per call so the minted token is captured without shared
  // mutable state between concurrent buyers.
  buyPassHandler = (async (args: Record<string, never>, extra: unknown) => {
    const minted: { token?: string; nonce?: string; payload?: Record<string, unknown> } = {};
    const wrapped = paidPass(async (_args: Record<string, never>, ctx: MCPToolContext) => {
      // Minted PENDING: the wrapper hands this result to the caller before it
      // settles, so the token must not work until settlement is resolved.
      //
      // NOTE the shape: the wrapper does NOT forward the MCP SDK's `extra`. It
      // builds its own context `{ toolName, arguments, meta }` and passes that,
      // so the payment rides at ctx.meta - reading extra._meta silently yields
      // undefined, and every paid pass would mint uncorrelated and never
      // activate: a 100% failure rate on real sales that tests calling
      // activatePass directly cannot see.
      // Typed, not cast: if the library ever renames this field the build
      // breaks instead of silently yielding undefined (which is precisely how
      // the extra._meta version passed tsc and failed every real sale).
      const nonce = authNonceOf(ctx?.meta?.['x402/payment']);
      const pass = mintPass({ pending: true, nonce: nonce ?? undefined });
      minted.token = pass.token;
      minted.nonce = nonce ?? undefined;
      const payload = {
        pass_token: pass.token,
        expires_at: pass.expires_at,
        call_cap: pass.call_cap,
        how_to_use: {
          mcp: 'attach the token at _meta["btx/pass"] on tools/call',
          rest: `POST ${PUBLIC_URL}/explain with header "X-BTX-Pass: <token>"`,
        },
        keep_this_token: 'This is a bearer pass. It is the only proof of purchase; store it now.',
      };
      minted.payload = payload;
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    });

    const result = await wrapped(args, extra);

    // Settle THREW (facilitator timeout, non-2xx, unparseable body). No
    // settlement hook fires on that path and the wrapper discards our result
    // for a fresh 402, so the customer would be told to pay again while their
    // payment may be confirming, and the pass would sit pending forever.
    // Having minted means verify passed, so a payment was authorised: activate
    // and hand the token back rather than stranding them.
    if (result?.isError && minted.token && minted.nonce) {
      console.error(
        `[pass] $${PASS_PRICE_USD} SETTLE THREW - activating and returning the token; funds may be in flight. ` +
          `nonce=${minted.nonce}`,
      );
      activatePass(minted.nonce, undefined, 'settle threw; no settlement response');
      const payload = {
        ...(minted.payload ?? {}),
        settlement: 'confirming',
        note:
          'Your payment was authorised but the settlement response did not arrive in time. This pass is active. ' +
          'Do not pay again; if anything is wrong the operator has been alerted with your payment reference.',
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    }
    return result;
  }) as typeof buyPassHandler;
  httpPaymentRequired = {
    x402Version: 2,
    error: 'Payment required to access this tool',
    resource: RESOURCE_INFO,
    accepts,
    extensions: BAZAAR_EXTENSIONS,
    hint:
      `First ${process.env.FREE_CALLS_PER_IP ?? '10'} calls per client are free - no account, no API key. ` +
      'This is an MCP server (streamable HTTP). Connect an MCP client with header ' +
      '"Accept: application/json, text/event-stream" and call the explain_transaction tool; ' +
      'payment settles over the x402 MCP transport (_meta["x402/payment"]). ' +
      `Prefer plain HTTP? POST ${PUBLIC_URL}/explain with {"tx_hash":"0x..."} speaks the standard x402 HTTP flow. ` +
      `Heavy use: a $${PASS_PRICE_USD} ${PASS_DAYS}-day pass (${PASS_CALL_CAP.toLocaleString('en-US')} calls) via POST ${PUBLIC_URL}/pass or the buy_pass tool. ` +
      `Deterministic decode: same hash, same JSON. Docs: ${SITE_URL}/docs/ | OpenAPI: ${PUBLIC_URL}/openapi.json | llms.txt: ${PUBLIC_URL}/llms.txt`,
  };
  console.log(
    `x402 payments enabled: $${PRICE_USD}/call USDC on Base to ${payTo} ` +
      `(facilitators: ${facilitatorNames.join(' -> ')})`,
  );
}

/**
 * Stateless streamable HTTP: a fresh McpServer per request. `charge` decides
 * whether this request's tool call goes through the x402 payment wrapper.
 * Free calls that die on our side (degraded RPC, internal error) are refunded
 * to the client's tier; invalid input still costs the call. Paid calls never
 * settle on error - the payment wrapper cancels settlement for isError results.
 */
function getServer(charge: boolean, ip: string, passToken: string | null = null): McpServer {
  const server = new McpServer({ name: 'base-tx-explain', version: VERSION });
  const freeHandler = async (args: { tx_hash: string }): Promise<ToolResult> => {
    const result = await runExplain(args);
    // Apify marketplace billing (pay-per-event): charge only after a clean
    // decode - never for errors, ours or the user's. No-op off Apify.
    if (!result.isError) await chargeApifyCall();
    if (PAYMENT_MODE === 'x402' && result.isError) {
      try {
        const code = JSON.parse((result.content[0] as { text: string }).text).code as string;
        // Our failures refund; so does invalid_hash, which we reject before
        // doing any work - the REST rail already treats a typo that way, and
        // the two rails must not differ on what costs a credit.
        if (code === 'upstream_error' || code === 'internal_error' || code === 'invalid_hash') {
          if (passToken) refundPassUse(passToken);
          else refundFreeCall(ip);
        }
      } catch {
        /* unparseable error payload; keep the call consumed */
      }
    }
    return result;
  };
  const handler = charge && paidHandler ? paidHandler : freeHandler;
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Explain Base transaction',
      description: TOOL_DESCRIPTION,
      inputSchema: INPUT_SHAPE,
    },
    handler as Parameters<typeof server.registerTool>[2],
  );
  if (buyPassHandler) {
    server.registerTool(
      'buy_pass',
      {
        title: `Buy a ${PASS_DAYS}-day pass`,
        description:
          `Buy a ${PASS_DAYS}-day pass for $${PASS_PRICE_USD} in USDC on Base via x402: up to ` +
          `${PASS_CALL_CAP.toLocaleString('en-US')} explain_transaction calls with no per-call payment. ` +
          'Returns a bearer pass token; attach it at _meta["btx/pass"] on MCP calls or as the ' +
          'X-BTX-Pass header on POST /explain. No account; the token is the only proof of purchase. ' +
          'Renew by buying a new pass after expiry.',
        inputSchema: {},
      },
      buyPassHandler as Parameters<typeof server.registerTool>[2],
    );
  }
  return server;
}

const app = express();
// Trust exactly one proxy hop (Fly's edge). `trust proxy: true` trusted the
// whole client-supplied X-Forwarded-For chain, which let anyone mint a fresh
// free tier per request with a forged header.
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));

// On Fly the edge stamps Fly-Client-IP itself; elsewhere fall back to
// Express's rightmost-untrusted-hop resolution.
const ON_FLY = Boolean(process.env.FLY_APP_NAME);
const clientIpOf = (req: express.Request): string => {
  if (ON_FLY) {
    const flyIp = req.headers['fly-client-ip'];
    if (typeof flyIp === 'string' && flyIp) return flyIp;
  }
  return req.ip ?? 'unknown';
};

// Root responds instantly: humans, uptime checks, and the Apify standby
// readiness probe (which GETs / with x-apify-container-server-readiness-probe).
app.get('/', (_req, res) => {
  res
    .status(200)
    .type('text/plain')
    .send(
      `base-tx-explain v${VERSION} - MCP server (streamable HTTP) at POST /mcp\n` +
        `Tool: ${TOOL_NAME}(tx_hash) - Base mainnet only.\n` +
        `\n` +
        `REST:     POST ${PUBLIC_URL}/explain with {"tx_hash":"0x..."} (same decode, plain HTTP)\n` +
        `OpenAPI:  ${PUBLIC_URL}/openapi.json\n` +
        `Health:   ${PUBLIC_URL}/healthz\n` +
        `Docs:     ${SITE_URL}/docs/\n` +
        `Registry: io.github.0200project/base-tx-explain (registry.modelcontextprotocol.io)\n` +
        `Pricing:  10 free calls per client, then $${PRICE_USD}/call in USDC on Base via x402.\n` +
        `Pass:     $${PASS_PRICE_USD} for ${PASS_DAYS} days / ${PASS_CALL_CAP.toLocaleString('en-US')} calls - POST ${PUBLIC_URL}/pass or the buy_pass tool.\n`,
    );
});

// Machine-readable map for agents probing the origin they were handed.
app.get('/llms.txt', (_req, res) => {
  res
    .status(200)
    .type('text/plain')
    .send(
      `# base-tx-explain\n\n` +
        `> One MCP tool: explain_transaction(tx_hash) -> strict JSON explanation of any Base mainnet (chain id 8453) transaction. Deterministic onchain decode, no LLM in the response path.\n\n` +
        `MCP endpoint (streamable HTTP): POST ${PUBLIC_URL}/mcp\n` +
        `REST endpoint (standard x402 HTTP flow): POST ${PUBLIC_URL}/explain with {"tx_hash":"0x..."}\n` +
        `Pricing: first 10 calls free per client, then $${PRICE_USD} per call in USDC on Base via x402 (MCP: challenge in-band, attach payment at _meta["x402/payment"] and retry; REST: standard 402 + PAYMENT-REQUIRED header). No account, no API key.\n` +
        `Pass: $${PASS_PRICE_USD} buys ${PASS_DAYS} days / ${PASS_CALL_CAP.toLocaleString('en-US')} calls - POST ${PUBLIC_URL}/pass or the buy_pass MCP tool; present the token as X-BTX-Pass (REST) or _meta["btx/pass"] (MCP).\n\n` +
        `## Contracts\n\n` +
        `- [OpenAPI](${PUBLIC_URL}/openapi.json): request/response schemas for the tools/call envelope\n` +
        `- [Health](${PUBLIC_URL}/healthz): liveness and demand counters\n\n` +
        `## Docs\n\n` +
        `- [Documentation](${SITE_URL}/docs/): request format, field contract, x402 payment loop, self-hosting\n` +
        `- [Site](${SITE_URL}/): product overview\n` +
        `- [Source](https://github.com/0200project/base-tx-explain)\n` +
        `- MCP registry name: io.github.0200project/base-tx-explain\n`,
    );
});

app.get('/robots.txt', (_req, res) => {
  res.status(200).type('text/plain').send('User-agent: *\nAllow: /\nDisallow: /dashboard\n');
});

// Discovery crawlers (x402scan among them) probe /favicon.ico for a site icon.
app.get('/favicon.ico', (_req, res) => {
  res.status(200).type('image/png').set('Cache-Control', 'public, max-age=86400').send(FAVICON_PNG);
});
// Since-boot demand counters: enough to see whether strangers are calling,
// deliberately nothing that identifies them.
const metrics = { tool_calls: 0, free: 0, paywalled: 0, booted_at: new Date().toISOString() };

app.get('/healthz', (_req, res) => {
  const snapshot = usageSnapshot(1) as { lifetime: Record<string, unknown> };
  res
    .status(200)
    .set('Access-Control-Allow-Origin', '*')
    .json({ ok: true, version: VERSION, payment_mode: PAYMENT_MODE, metrics, lifetime: snapshot.lifetime });
});

// Founder stats: full daily series behind a bearer token. Absent token
// config keeps the endpoint dark. CORS is open because the dashboard is a
// static page on another origin and the token is the actual gate.
const STATS_TOKEN = process.env.STATS_TOKEN ?? '';
app.options('/stats', (_req, res) => {
  res
    .set('Access-Control-Allow-Origin', '*')
    .set('Access-Control-Allow-Headers', 'authorization, x-stats-token')
    .status(204)
    .end();
});
// Hash both sides so timingSafeEqual gets equal-length buffers.
const tokenMatches = (presented: string): boolean => {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(STATS_TOKEN).digest();
  return timingSafeEqual(a, b);
};

// --- Founder dashboard: the /dashboard page is cookie-gated with the same
// token that gates /stats. The cookie never holds the token itself, only a
// digest derived from it, so rotating STATS_TOKEN invalidates all sessions.
const DASH_COOKIE = 'btx_dash';
const dashCookieValue = (): string =>
  createHash('sha256').update(`btx-dash-v1:${STATS_TOKEN}`).digest('hex');

const hasDashCookie = (req: express.Request): boolean => {
  if (!STATS_TOKEN) return false;
  const m = new RegExp(`(?:^|;\\s*)${DASH_COOKIE}=([0-9a-f]{64})`).exec(String(req.headers.cookie ?? ''));
  const presented = m?.[1];
  if (!presented) return false;
  // Both sides are exactly 32 bytes (the regex admits only 64 hex chars).
  return timingSafeEqual(Buffer.from(presented, 'hex'), Buffer.from(dashCookieValue(), 'hex'));
};

const DASH_COOKIE_FLAGS = 'Path=/; HttpOnly; Secure; SameSite=Lax';
const setDashHeaders = (res: express.Response): express.Response =>
  res.set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex, nofollow');

app.get('/dashboard', (req, res) => {
  if (!STATS_TOKEN) {
    res.status(404).type('text/plain').send('Not found.\n');
    return;
  }
  setDashHeaders(res)
    .status(hasDashCookie(req) ? 200 : 401)
    .type('html')
    .send(hasDashCookie(req) ? dashboardPage() : loginPage());
});

app.post('/dashboard/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
  if (!STATS_TOKEN) {
    res.status(404).type('text/plain').send('Not found.\n');
    return;
  }
  setDashHeaders(res);
  if (!withinRateLimit(clientIpOf(req))) {
    res.status(429).type('html').send(loginPage({ error: 'Too many attempts. Wait a minute and try again.' }));
    return;
  }
  const presented = typeof (req.body as Record<string, unknown>)?.token === 'string'
    ? ((req.body as Record<string, string>).token ?? '').trim()
    : '';
  if (!presented || !tokenMatches(presented)) {
    res.status(401).type('html').send(loginPage({ error: 'That token is not right.' }));
    return;
  }
  res
    .set('Set-Cookie', `${DASH_COOKIE}=${dashCookieValue()}; Max-Age=2592000; ${DASH_COOKIE_FLAGS}`)
    .redirect(303, '/dashboard');
});

app.post('/dashboard/logout', (_req, res) => {
  setDashHeaders(res)
    .set('Set-Cookie', `${DASH_COOKIE}=; Max-Age=0; ${DASH_COOKIE_FLAGS}`)
    .redirect(303, '/dashboard');
});

app.get('/stats', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*').set('Cache-Control', 'no-store');
  if (!STATS_TOKEN) {
    res.status(404).json({ error: 'stats not enabled' });
    return;
  }
  const presented =
    (req.headers['x-stats-token'] as string | undefined) ??
    String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  // Two accepted credentials: the token itself (header, for curl and any
  // external tooling) or the dashboard's same-origin session cookie.
  const authed = presented ? tokenMatches(presented) : hasDashCookie(req);
  if (!authed) {
    res.status(401).json({ error: 'bad token' });
    return;
  }
  // Read the payout balance server-side: the dashboard should not depend on a
  // third-party explorer being up to show the number that matters most.
  const treasury = await getTreasury(process.env.X402_PAY_TO ?? '');
  res.status(200).json({
    version: VERSION,
    payment_mode: PAYMENT_MODE,
    price_usd: PRICE_USD,
    since_boot: metrics,
    treasury,
    ...usageSnapshot(30),
    passes: passSnapshot(),
  });
});

// Canonical machine-readable contract for discovery indexers (x402scan et al.).
const openApiDocument = buildOpenApiDocument(VERSION, PRICE_USD, PAYMENT_MODE === 'x402', PUBLIC_URL);
app.get('/openapi.json', (_req, res) => {
  res.status(200).json(openApiDocument);
});

/** MCP streamable-HTTP clients must accept SSE; anything else is a plain-HTTP caller. */
const isMcpClient = (req: express.Request): boolean =>
  String(req.headers.accept ?? '').includes('text/event-stream');

/** x402 v2 wire format: the PaymentRequired payload rides in a base64 response header. */
function send402(res: express.Response): void {
  if (!httpPaymentRequired) {
    res.status(500).json({ error: 'payment configuration missing' });
    return;
  }
  const { hint, ...paymentRequired } = httpPaymentRequired;
  res
    .status(402)
    .set('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(paymentRequired)).toString('base64'))
    .json(httpPaymentRequired);
}

// Browser clients (the site playground) need CORS; the payment challenge
// header must be exposed for the pay-and-retry loop to work from a page.
const MCP_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'PAYMENT-REQUIRED, mcp-session-id',
};
app.options('/mcp', (_req, res) => {
  res
    .set(MCP_CORS)
    .set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    .set('Access-Control-Allow-Headers', 'content-type, accept, authorization, mcp-protocol-version, mcp-session-id, last-event-id')
    .status(204)
    .end();
});

app.post('/mcp', async (req, res) => {
  res.set(MCP_CORS);
  const ip = clientIpOf(req);
  // On Apify every standby run serves exactly one metered, billed customer,
  // and req.ip resolves to Apify's proxy - one shared bucket would let one
  // customer 429 another. The platform does its own metering there.
  if (!APIFY_BILLING_ACTIVE && !withinRateLimit(ip)) {
    res.status(429).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Rate limit exceeded: max 60 requests/minute per client.' },
      id: null,
    });
    return;
  }

  // Plain-HTTP callers (discovery probes, curl) get the x402 402 face
  // instead of the transport's 406.
  if (httpPaymentRequired && !isMcpClient(req)) {
    send402(res);
    return;
  }

  const messages = Array.isArray(req.body) ? req.body : [req.body];
  const toolCallCount = messages.filter((m) => m?.method === 'tools/call').length;
  const isToolCall = toolCallCount > 0;

  // JSON-RPC batching was removed in MCP 2025-06-18, but older clients can
  // still send arrays; N executions must not ride on one free call.
  if (toolCallCount > 1) {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Batched tools/call requests are not supported; send one call per request.' },
      id: null,
    });
    return;
  }

  // buy_pass is always charged: there is no free tier on a $9 purchase.
  const isBuyPass = messages.some((m) => m?.method === 'tools/call' && m?.params?.name === 'buy_pass');

  let charge = false;
  let hasPayment = false;
  let passToken: string | null = null;
  if (PAYMENT_MODE === 'x402' && isToolCall && !isBuyPass) {
    // A valid pass wins first - the holder paid to skip both the free tier
    // and per-call payments. Then a payment-carrying retry, then free tier.
    const presented =
      (req.headers['x-btx-pass'] as string | undefined) ??
      (messages.find((m) => typeof m?.params?._meta?.['btx/pass'] === 'string')?.params?._meta?.['btx/pass'] as
        | string
        | undefined);
    if (presented && usePass(presented).ok) passToken = presented;
    if (!passToken) {
      hasPayment = messages.some((m) => m?.params?._meta?.['x402/payment'] !== undefined);
      charge = hasPayment || !consumeFreeCall(ip);
    }
  }
  if (isBuyPass) charge = true;

  if (isToolCall) {
    metrics.tool_calls++;
    if (charge) metrics.paywalled++;
    else metrics.free++;
    const ipTag = createHash('sha256').update(`btx:${ip}`).digest('hex').slice(0, 8);
    const kind = passToken ? 'pass' : charge ? (hasPayment ? 'paid-retry' : isBuyPass ? 'buy-pass' : 'paywalled') : 'free';
    console.log(`[call] ${new Date().toISOString()} ${kind} client=${ipTag}`);
    recordEvent({ t: new Date().toISOString(), e: 'call', charge, paid: hasPayment, pass: Boolean(passToken), client: ipTag });
  }

  const server = getServer(charge, ip, passToken);
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP request failed:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// Stateless servers: no server-initiated SSE, no session teardown.
const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
};
app.get('/mcp', (req, res) => {
  res.set(MCP_CORS);
  if (httpPaymentRequired && !isMcpClient(req)) {
    send402(res);
    return;
  }
  methodNotAllowed(req, res);
});
app.delete('/mcp', methodNotAllowed);

const port = Number.parseInt(
  process.env.ACTOR_WEB_SERVER_PORT ?? process.env.PORT ?? '3000',
  10,
);

initUsageLedger();
initFreeTier();
initPasses();

initApifyBilling()
  .then(() => initPayments())
  .then(() => {
    // REST rail. Registered after initPayments so it shares the same
    // configured resource server; only in x402 mode, since without payments
    // configured there is nothing to gate it with.
    if (PAYMENT_MODE === 'x402' && sharedResourceServer) {
      registerRestRoutes(app, {
        resourceServer: sharedResourceServer,
        payTo: sharedPayTo,
        priceUsd: PRICE_USD,
        network: NETWORK,
        publicUrl: PUBLIC_URL,
        tryFreeCall: (req) => consumeFreeCall(clientIpOf(req)),
        refundFreeCall: (req) => refundFreeCall(clientIpOf(req)),
        tryPass: (req) => {
          const token = req.headers['x-btx-pass'];
          if (typeof token !== 'string' || !token) return null;
          return usePass(token).ok ? token : null;
        },
        refundPassUse,
        record: (req, charged, ok, viaPass) => {
          metrics.tool_calls++;
          if (charged) metrics.paywalled++;
          else metrics.free++;
          const tag = createHash('sha256').update(`btx:${clientIpOf(req)}`).digest('hex').slice(0, 8);
          console.log(`[rest] ${new Date().toISOString()} ${viaPass ? 'pass' : charged ? 'paid' : 'free'} ok=${ok} client=${tag}`);
          recordEvent({ t: new Date().toISOString(), e: 'call', charge: charged, paid: charged, pass: viaPass, client: tag, ok });
        },
      });
      registerPassRoutes(app, {
        resourceServer: sharedResourceServer,
        payTo: sharedPayTo,
        priceUsd: PASS_PRICE_USD,
        network: NETWORK,
        publicUrl: PUBLIC_URL,
        callCap: PASS_CALL_CAP,
        days: PASS_DAYS,
        // Active on mint: the x402 express middleware buffers the response and
        // discards the body when settlement fails, so a REST caller cannot
        // receive this token without having paid. Minting pending here would
        // strand real payers - nothing on this rail activates them.
        mint: () => mintPass(),
        revoke: revokePass,
        recordSale: () => {
          // Called only once the response was actually delivered, which on this
          // rail means settlement succeeded. Booking before that inflated the
          // revenue line with sales that never happened - and an over-reported
          // sale is invisible from inside the ledger, while an under-reported
          // one is always recoverable from the payout wallet on-chain.
          recordEvent({ t: new Date().toISOString(), e: 'settled', client: 'rest-pass', amount_usd: Number.parseFloat(PASS_PRICE_USD) });
        },
      });
      console.log(`REST rail: POST ${PUBLIC_URL}/explain ($${PRICE_USD}/call) and POST ${PUBLIC_URL}/pass ($${PASS_PRICE_USD}/${PASS_DAYS}d) via x402 HTTP`);
    }
    app.listen(port, () => {
      console.log(`base-tx-explain v${VERSION} listening on :${port} (payment mode: ${PAYMENT_MODE})`);
    });
  })
  .catch((err) => {
    console.error('Startup failed:', err);
    process.exit(1);
  });
