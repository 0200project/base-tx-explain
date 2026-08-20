import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { createPaymentWrapper, type ToolResult } from '@x402/mcp';
import express from 'express';
import * as z from 'zod/v4';
import { ExplainError, explainTransaction } from './explain.js';
import { consumeFreeCall, withinRateLimit } from './freeTier.js';

const VERSION = '0.1.0';
const NETWORK = 'eip155:8453' as const; // Base mainnet
const PAYMENT_MODE = process.env.PAYMENT_MODE === 'x402' ? 'x402' : 'none';
const PRICE_USD = process.env.X402_PRICE_USD ?? '0.02';

const TOOL_NAME = 'explain_transaction';
const TOOL_DESCRIPTION =
  'Explain a Base-mainnet transaction in plain English. Input: a transaction hash. ' +
  'Returns strict JSON: summary (1-3 sentences), action_type (swap, erc20_transfer, ' +
  'nft_mint, bridge_out, approval_for_all, ...), assets_moved[] (token, amount, from, to), ' +
  'counterparties[] (labeled where known: routers, bridges, marketplaces), risk_flags[] ' +
  '(unverified_contract, unlimited_approval, approval_for_all, known_drainer, ' +
  'first_time_counterparty, transaction_reverted), gas_paid_usd, timestamp, basescan_url. ' +
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

async function initPayments(): Promise<void> {
  if (PAYMENT_MODE !== 'x402') return;
  const payTo = process.env.X402_PAY_TO ?? '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo) || /^0x0{40}$/.test(payTo)) {
    throw new Error('PAYMENT_MODE=x402 requires X402_PAY_TO to be set to a real receiving address.');
  }
  const facilitatorUrl = process.env.X402_FACILITATOR_URL || 'https://facilitator.payai.network';
  const facilitator = new HTTPFacilitatorClient({ url: facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitator).register(NETWORK, new ExactEvmScheme());
  await resourceServer.initialize();
  const accepts = await resourceServer.buildPaymentRequirements({
    scheme: 'exact',
    network: NETWORK,
    payTo,
    price: `$${PRICE_USD}`,
  });
  const paid = createPaymentWrapper(resourceServer, {
    accepts,
    resource: {
      url: `mcp://tool/${TOOL_NAME}`,
      description: TOOL_DESCRIPTION,
      mimeType: 'application/json',
      serviceName: 'base-tx-explain',
      tags: ['base', 'transaction', 'decoder', 'blockchain', 'risk'],
    },
    extensions: declareDiscoveryExtension({
      toolName: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: { tx_hash: { type: 'string', description: 'Base mainnet transaction hash (0x + 64 hex chars)' } },
        required: ['tx_hash'],
      },
      example: { tx_hash: '0x' + 'ab'.repeat(32) },
    }),
  });
  paidHandler = paid(runExplain) as typeof paidHandler;
  console.log(`x402 payments enabled: $${PRICE_USD}/call USDC on Base to ${payTo} (facilitator: ${facilitatorUrl})`);
}

/**
 * Stateless streamable HTTP: a fresh McpServer per request. `charge` decides
 * whether this request's tool call goes through the x402 payment wrapper.
 */
function getServer(charge: boolean): McpServer {
  const server = new McpServer({ name: 'base-tx-explain', version: VERSION });
  const handler = charge && paidHandler ? paidHandler : runExplain;
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Explain Base transaction',
      description: TOOL_DESCRIPTION,
      inputSchema: INPUT_SHAPE,
    },
    handler as Parameters<typeof server.registerTool>[2],
  );
  return server;
}

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '256kb' }));

// Root responds instantly: humans, uptime checks, and the Apify standby
// readiness probe (which GETs / with x-apify-container-server-readiness-probe).
app.get('/', (_req, res) => {
  res
    .status(200)
    .type('text/plain')
    .send(`base-tx-explain v${VERSION} - MCP server (streamable HTTP) at POST /mcp\nTool: ${TOOL_NAME}(tx_hash) - Base mainnet only.\n`);
});
// Since-boot demand counters: enough to see whether strangers are calling,
// deliberately nothing that identifies them.
const metrics = { tool_calls: 0, free: 0, paywalled: 0, booted_at: new Date().toISOString() };

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true, version: VERSION, payment_mode: PAYMENT_MODE, metrics });
});

app.post('/mcp', async (req, res) => {
  const ip = req.ip ?? 'unknown';
  if (!withinRateLimit(ip)) {
    res.status(429).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Rate limit exceeded: max 60 requests/minute per client.' },
      id: null,
    });
    return;
  }

  const messages = Array.isArray(req.body) ? req.body : [req.body];
  const isToolCall = messages.some((m) => m?.method === 'tools/call');

  let charge = false;
  if (PAYMENT_MODE === 'x402' && isToolCall) {
    // A retry that already carries a payment must charge (and must not burn
    // a free call); otherwise a free call is consumed if any remain.
    const hasPayment = messages.some((m) => m?.params?._meta?.['x402/payment'] !== undefined);
    charge = hasPayment || !consumeFreeCall(ip);
  }

  if (isToolCall) {
    metrics.tool_calls++;
    if (charge) metrics.paywalled++;
    else metrics.free++;
    const ipTag = createHash('sha256').update(`btx:${ip}`).digest('hex').slice(0, 8);
    console.log(`[call] ${new Date().toISOString()} ${charge ? 'paywalled' : 'free'} client=${ipTag}`);
  }

  const server = getServer(charge);
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
app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

const port = Number.parseInt(
  process.env.ACTOR_WEB_SERVER_PORT ?? process.env.PORT ?? '3000',
  10,
);

initPayments()
  .then(() => {
    app.listen(port, () => {
      console.log(`base-tx-explain v${VERSION} listening on :${port} (payment mode: ${PAYMENT_MODE})`);
    });
  })
  .catch((err) => {
    console.error('Startup failed:', err);
    process.exit(1);
  });
