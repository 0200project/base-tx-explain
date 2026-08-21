# Handing a prospect something that works

Paste-ready. Every claim below was verified against the deployed server on
2026-08-21; the "verified" column says how, because a technical prospect will
check and being wrong in front of them costs more than the sale.

## The whole setup

```
https://base-tx-explain.fly.dev/mcp
```

That is it. Paste it into any MCP client as a remote server URL — Claude Desktop,
Cursor, Claude Code, anything speaking Streamable HTTP. **No account, no key, no
signup.** The first calls are free.

For `POST /explain` instead of MCP:

```bash
curl -s -X POST https://base-tx-explain.fly.dev/explain \
  -H 'content-type: application/json' \
  -d '{"tx_hash":"0xbe19b79fb578f9714d7f01a871d83eeec6ed19bf6a9a3df514a176d75251581c"}'
```

> **If you run that curl yourself and get `Payment required`, nothing is broken.**
> The free tier is **per IP**, and ours is spent — we have made 126 calls from
> this address. A prospect on a fresh IP gets their 10. Verified: running the
> exact curl above from here returns 402 today, which is correct behaviour and
> not what they will see. Do not "fix" it, and do not let a 402 from your own
> machine convince you the free tier is off.

## What they get, and how each was checked

| Claim | Verified |
|---|---|
| MCP handshake works, no auth | `initialize` returns `serverInfo: base-tx-explain 0.1.2` |
| Two tools listed | `tools/list` → `explain_transaction`, `buy_pass` |
| **10 free calls per IP**, 30-day window | `FREE_CALLS_PER_IP` default 10, `WINDOW_MS` 30 days, `freeTier.ts` |
| Rate limit 60/min | `RATE_LIMIT_PER_MINUTE` in `freeTier.ts` |
| `gas_paid_usd` as a discrete converted field | live: `0.000351` and `0.00866` on two real txs |
| Reverted → `assets_moved: []` | live: a reverted tx returned `status: reverted`, `[]` |
| Deterministic, no LLM in the response path | architectural; same input, same bytes |
| `checks` object states which risk lookups ran | in every response; no explorer publishes this |

**Do NOT claim** we decode unverified contracts better than Blockscout. Measured
at 0/13 — see `segment-research-2026-08-21.md`. The honest line is *"we tell you
what we could not determine instead of returning null."*

## The 402 shape: not a defect, and do not apologise for it

**Corrected 2026-08-21 after reading `@x402/mcp` 2.23.0 rather than taking the
report at face value.** This was carried for a day as a known bug of ours. It is
not one, and disclosing it as one would suggest we do not understand our own
protocol.

An unpaid MCP `tools/call` returns `isError: true`, the challenge JSON in
`content[0].text`, and the parsed object in `structuredContent`. That is exactly
what the library's own server emits and exactly what its client requires:

```js
// @x402/mcp client
extractPaymentRequiredFromResult(result) {
  if (!result.isError) return null;   // isError:true is MANDATORY
  if (result.structuredContent) { ... }   // preferred
  // else content[0].text            // required
}
```

Its own comment reads: *"Per MCP transport spec, supports: 1. structuredContent
(optional, preferred) 2. content[0].text (required)."* We emit all three fields.

`_meta` is not where a challenge lives. It carries the payment in
(`x402/payment`) and the settlement receipt back (`x402/payment-response`).
Expecting the challenge there conflates the receipt with the challenge.

**Empirical proof it is not blocking:** Circadian, an external party with their
own client, completed a real settled payment through this exact path.

**What IS true, and worth saying:** a *plain* MCP client with no x402 wrapper
sees `isError: true` and reads it as a tool failure. That is inherent — the
challenge has to be an error for the wrapper to detect it. So the honest line is
**"you need an x402-capable client; with a plain MCP client the 402 surfaces as
isError, which is per spec"** — not "we have a bug here."

## Paying, if they get that far

- **Per call:** $0.02 USDC on Base over x402. EIP-3009, so the payer signs and
  the facilitator submits — **no ETH needed for gas.**
- **Pass:** $9 for 30 days, up to 10,000 calls. `buy_pass` over x402, or card.
- **Card:** works, but see `webhook.status` on `/stats` first. It currently reads
  `never_exercised` — the secret was rotated and no delivery has tested it. Prefer
  x402 for anyone already x402-native; it is the rail with a demonstrated
  end-to-end settlement.

## If they engage technically

Loop in Platform rather than explaining the flow. A working artifact beats an
accurate description: Circadian verified our decode field by field before saying
anything, and a technical prospect will do the same.
