/**
 * OpenAPI document served at /openapi.json.
 * Discovery indexers (x402scan and compatible crawlers) treat this as the
 * canonical machine-readable contract; the runtime 402 challenge remains the
 * source of truth for payment. The x-payment-info extension follows the
 * x402scan discovery spec (decimal USD here; atomic units on the wire).
 */

const EXPLAIN_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Plain-English 1-3 sentence explanation' },
    action_type: { type: 'string', description: 'One of ~30 deterministic action types (swap, erc20_transfer, nft_mint, bridge_out, ...)' },
    status: { type: 'string', enum: ['success', 'reverted'] },
    assets_moved: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          token: { type: 'string' },
          amount: { type: 'string', description: 'Decimal string' },
          from: { type: 'string' },
          to: { type: 'string' },
          token_address: { type: ['string', 'null'] },
          token_id: { type: 'string' },
          standard: { type: 'string', enum: ['native', 'erc20', 'erc721', 'erc1155'] },
        },
        required: ['token', 'amount', 'from', 'to', 'standard'],
      },
    },
    counterparties: {
      type: 'array',
      items: {
        type: 'object',
        properties: { address: { type: 'string' }, label: { type: ['string', 'null'] } },
        required: ['address', 'label'],
      },
    },
    risk_flags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          flag: { type: 'string', enum: ['unverified_contract', 'first_time_counterparty', 'approval_for_all', 'unlimited_approval', 'known_drainer', 'transaction_reverted'] },
          detail: { type: 'string' },
        },
        required: ['flag', 'detail'],
      },
    },
    gas_paid_usd: { type: ['number', 'null'] },
    timestamp: { type: 'string' },
    block_number: { type: 'number' },
    tx_hash: { type: 'string' },
    basescan_url: { type: 'string' },
    partial: { type: 'boolean' },
  },
  required: ['summary', 'action_type', 'status', 'assets_moved', 'counterparties', 'risk_flags', 'gas_paid_usd', 'timestamp', 'basescan_url'],
} as const;

export function buildOpenApiDocument(
  version: string,
  priceUsd: string,
  paid: boolean,
  publicUrl: string,
): Record<string, unknown> {
  const operation: Record<string, unknown> = {
    operationId: 'explain_transaction',
    summary: 'Explain a Base mainnet transaction in plain English (MCP tools/call)',
    tags: ['Blockchain'],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            description: 'MCP JSON-RPC 2.0 envelope. This is an MCP server over streamable HTTP; send Accept: application/json, text/event-stream.',
            properties: {
              jsonrpc: { type: 'string', const: '2.0' },
              id: { type: ['string', 'number'] },
              method: { type: 'string', const: 'tools/call' },
              params: {
                type: 'object',
                properties: {
                  name: { type: 'string', const: 'explain_transaction' },
                  arguments: {
                    type: 'object',
                    properties: {
                      tx_hash: {
                        type: 'string',
                        pattern: '^0x[0-9a-fA-F]{64}$',
                        description: 'The Base mainnet transaction hash to explain',
                      },
                    },
                    required: ['tx_hash'],
                  },
                },
                required: ['name', 'arguments'],
              },
            },
            required: ['jsonrpc', 'id', 'method', 'params'],
          },
        },
      },
    },
    responses: {
      '200': {
        description: 'JSON-RPC result whose structuredContent is the explanation object',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                jsonrpc: { type: 'string' },
                id: { type: ['string', 'number'] },
                result: {
                  type: 'object',
                  properties: {
                    content: { type: 'array', items: { type: 'object' } },
                    structuredContent: EXPLAIN_RESULT_SCHEMA,
                  },
                },
              },
              required: ['jsonrpc', 'result'],
            },
          },
        },
      },
      '402': {
        description:
          'Payment Required. The x402 v2 challenge is returned both in the JSON body and base64-encoded in the PAYMENT-REQUIRED response header.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                x402Version: { type: 'number', const: 2 },
                error: { type: 'string' },
                resource: {
                  type: 'object',
                  properties: {
                    url: { type: 'string' },
                    description: { type: 'string' },
                    mimeType: { type: 'string' },
                  },
                },
                accepts: {
                  type: 'array',
                  description: 'x402 payment requirements: scheme, network, asset, amount in atomic units, payTo',
                  items: { type: 'object' },
                },
              },
              required: ['x402Version', 'accepts'],
            },
          },
        },
      },
    },
  };
  if (paid) {
    operation['x-payment-info'] = {
      price: { mode: 'fixed', currency: 'USD', amount: Number.parseFloat(priceUsd).toFixed(6) },
      protocols: [{ x402: {} }],
    };
  }

  return {
    openapi: '3.1.0',
    servers: [{ url: publicUrl, description: 'Production' }],
    externalDocs: { url: 'https://0200project.com/docs/', description: 'Full documentation' },
    info: {
      title: 'base-tx-explain',
      version,
      contact: { name: '0200project', url: 'https://github.com/0200project/base-tx-explain/issues' },
      license: { name: 'MIT', identifier: 'MIT' },
      description:
        'Plain-English, deterministic decode of any Base mainnet transaction. Strict JSON: summary, action type, assets moved, labeled counterparties, risk flags, gas in USD. No LLM in the response path.',
      'x-guidance':
        'This is an MCP server (streamable HTTP). POST a JSON-RPC 2.0 envelope to /mcp with header "Accept: application/json, text/event-stream". Call method tools/call with name "explain_transaction" and arguments {"tx_hash": "0x..."} where tx_hash is a Base mainnet (chain id 8453) transaction hash. The first 10 calls per client are free; afterwards the server returns an x402 payment challenge for $' +
        priceUsd +
        ' USDC on Base — attach the payment payload at _meta["x402/payment"] per the x402 MCP transport and retry the same call. The result\'s structuredContent field carries the explanation object.',
    },
    paths: { '/mcp': { post: operation } },
  };
}
