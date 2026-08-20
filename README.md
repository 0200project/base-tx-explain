# base-tx-explain

**One MCP tool: `explain_transaction(tx_hash)` → strict JSON explanation of any Base mainnet transaction.**

Feed it a transaction hash. Get back what happened, in plain English, plus the structured facts: what moved, who was involved, what to be careful about, what it cost. Deterministic onchain decode — **no LLM anywhere in the response path**, so the same input always produces the same output, there is nothing to hallucinate, and the JSON contract is stable enough to parse blind.

Base mainnet (chain id 8453) only.

**Links:** [Live endpoint](https://base-tx-explain.fly.dev/mcp) · [Docs](https://0200project.github.io/docs/) · [OpenAPI](https://base-tx-explain.fly.dev/openapi.json) · MCP registry: `io.github.0200project/base-tx-explain` · [Site](https://0200project.github.io)

## For agents

```jsonc
// tools/call → explain_transaction
{ "tx_hash": "0x0c84b951051f779903b57af9225ca570c77cd5531195968dd78106a69d6c4d8c" }
```

returns (as both `structuredContent` and stringified JSON in `content[0].text`):

```json
{
  "summary": "0x401d...f2c5 swapped 0.03 ETH for 12,899,422 WNL via Uniswap V4 PoolManager.",
  "action_type": "swap",
  "status": "success",
  "assets_moved": [
    { "token": "ETH", "amount": "0.03", "from": "0x401d...", "to": "0xd0a4...", "token_address": null, "standard": "native" },
    { "token": "WNL", "amount": "12899422.144134853458613801", "from": "0x4985...", "to": "0x401d...", "token_address": "0xb200...9a01", "standard": "erc20" }
  ],
  "counterparties": [
    { "address": "0xd0a4...", "label": null },
    { "address": "0x4985...", "label": "Uniswap V4 PoolManager" }
  ],
  "risk_flags": [
    { "flag": "unverified_contract", "detail": "The target contract 0xd0a4...e4bf has no verified source code on Sourcify." }
  ],
  "gas_paid_usd": 0.020562,
  "timestamp": "2026-08-20T03:54:19.000Z",
  "block_number": 50204356,
  "tx_hash": "0x0c84...4c8c",
  "basescan_url": "https://basescan.org/tx/0x0c84...4c8c",
  "partial": false
}
```

### Field contract

- `action_type` — one of: `eth_transfer`, `erc20_transfer`, `erc20_approval`, `approval_revoked`, `approval_for_all`, `swap`, `add_liquidity`, `remove_liquidity`, `wrap`, `unwrap`, `nft_mint`, `nft_transfer`, `nft_sale`, `token_mint`, `bridge_in`, `bridge_out`, `lending_supply`, `lending_withdraw`, `lending_borrow`, `lending_repay`, `stake`, `unstake`, `claim`, `batch_transfer`, `account_abstraction_bundle`, `attestation`, `name_registration`, `contract_deployment`, `contract_interaction`, `unknown`.
- `risk_flags[].flag` — one of: `unverified_contract`, `first_time_counterparty`, `approval_for_all`, `unlimited_approval`, `known_drainer`, `transaction_reverted`. A flag always means evidence was found; a failed lookup never produces a flag.
- `status` — `success` or `reverted`. Reverted transactions are classified by intent (what was attempted) and carry a `transaction_reverted` risk flag.
- `partial: true` — the transaction's full meaning could not be established; `summary` states exactly what is and is not known. On errors the tool returns `isError: true` with `{ "error": "...", "code": "invalid_hash" | "not_found" | "pending" | "upstream_error" }`.
- Amounts are decimal strings (not floats). Addresses are as emitted onchain; compare case-insensitively.

### How it decodes

Raw transaction + receipt from Base RPC → builtin decoders for ~40 event formats (ERC-20/721/1155, Uniswap V2/V3/V4, Aerodrome/Solidly, Seaport, Aave V3, Compound V3, OP-stack bridges, ERC-4337 EntryPoint, EAS, Basenames, WETH, LP position managers) → deterministic rule-ordered classification → labels from a verified table of major Base contracts. App-specific events are named via the contract's **verified ABI on Sourcify** when available. Risk flags come from Sourcify/Basescan verification status, the ScamSniffer and MyEtherWallet public blocklists, and approval semantics. `gas_paid_usd` includes the OP-stack L1 data fee and prices ETH from the Chainlink ETH/USD feed **at the transaction's block**.

## Pricing

- **10 free calls** per client, no signup.
- After that: **$0.02 per call in USDC on Base via [x402](https://x402.org)** — the payment-required response contains everything an x402-capable agent needs to pay and retry autonomously. No account, no API key.
- Also available marketplace-hosted (marketplace billing applies there instead).

## Connect

```json
{
  "mcpServers": {
    "base-tx-explain": {
      "type": "streamable-http",
      "url": "https://base-tx-explain.fly.dev/mcp"
    }
  }
}
```

## Self-host

```bash
git clone https://github.com/0200project/base-tx-explain.git && cd base-tx-explain
npm install
cp .env.example .env   # defaults work: free mode, public Base RPCs
npm run dev            # or: npm run build && npm start
```

Environment (see `.env.example`): `PAYMENT_MODE` (`none` | `x402`), `X402_PAY_TO` (your receiving address — use a fresh wallet), `X402_PRICE_USD`, `X402_FACILITATOR_URL` (defaults to the keyless PayAI facilitator; Coinbase CDP facilitator also works and its API keys carry no spend exposure), `FREE_CALLS_PER_IP`, `BASE_RPC_URLS`, optional `ETHERSCAN_API_KEY`.

The server is stateless (fresh MCP server per request), so it scales horizontally and runs on anything that runs Docker — a `Dockerfile` and an Apify `.actor/` config are included.

```bash
npm test          # unit tests
npm run validate  # decode 100 recent live Base txs, print grades (ship gate: >=90% clean, 0 crashes)
```

## Guarantees and limits

- Deterministic: same tx hash → same decode. No model calls, ever.
- Internal ETH transfers (contract → contract value moves) are not visible without trace APIs; WETH events cover the common cases. When something can't be decoded, the output says so instead of guessing.
- Blocklists are consumed at runtime from their public sources and refresh twice daily; absence of a `known_drainer` flag is not a safety guarantee.
- Not financial advice; this tool reports what a transaction did, not whether anything is a good idea.
