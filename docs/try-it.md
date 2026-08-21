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

---

## A concrete before/after, for an x402-native prospect

Prepared 2026-08-21 for the AgentPay thread, but reusable for any prospect whose
own tool returns a settlement's recipient and amount and stops there. This is
**output, not a claim** — reproducible by anyone with the hash.

**Use this hash:** `0x6ce5e3948c9c6b8e0ef8413f3c29623163bb7b58155eda90a67464f3bb119110`

**Not** our own test settlement
(`0x2a2aaa…1939f`). It decodes identically, but its `from` and `to` are both our
wallets — anyone who looked it up would see us paying ourselves, which reads as a
manufactured example. The hash above has a genuine third-party payer.

What we return for that transaction, verbatim:

```json
{
  "summary": "0xb2bd...371b called contract Multicall3 (function: aggregate3).",
  "action_type": "contract_interaction",
  "status": "success",
  "assets_moved": [{
    "token": "USDC", "amount": "0.02",
    "from": "0x9f54460FED51892b3b065EAe3Ac1603dC3C6ECe4",
    "to":   "0xd4ec730aB062f20460727710fcE70664948a6BC9",
    "token_address": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "standard": "erc20"
  }],
  "counterparties": [{ "address": "0xca11...ca11", "label": "Multicall3" }],
  "risk_flags": [],
  "checks": {
    "contract_verification": "not_applicable",
    "first_interaction": "not_applicable",
    "drainer_blacklist": "ok",
    "unchecked_addresses": [], "note": null
  },
  "gas_paid_usd": 0.001588,
  "block_number": 50271571,
  "timestamp": "2026-08-21T17:14:49.000Z",
  "provenance": { "untrusted_fields": ["summary", "assets_moved[].token", "counterparties[].label"] }
}
```

The fields worth pointing at, and why each is hard to reconstruct from a
recipient-and-amount history:

| Field | Why it matters to an audit trail |
|---|---|
| `gas_paid_usd` | the cost side of the entry, already converted — not fee × rate |
| `assets_moved[].from` | the *payer*, which a recipient-only record never has |
| `token_address` + `standard` | which USDC, and that it is ERC-20 — not a symbol string |
| `counterparties[].label` | `Multicall3` resolved, so a batched settlement is not an opaque address |
| `status` | reverted settlements excluded from disposals |
| `checks` | which risk lookups ran, so an empty `risk_flags` is never read as "clean" |
| `provenance.untrusted_fields` | names the fields an attacker controls — no explorer publishes this |

### Two honesty constraints on using this

**Do not call it a customer payment.** It is Circadian's pre-arranged technical
probe by a party who evaluated us and declined to buy. It is a real, settled,
on-chain payment and fine as a decode example — it is not a sale, and
`knownNonRevenue.ts` says so.

**Say what the `checks` object is doing here.** Two of three read
`not_applicable` because a plain transfer extends no trust to a new contract —
nothing was skipped, there was nothing to look at. That is the field behaving
correctly, and it is the honest version. A richer transaction (a swap, an
approval) exercises all three. Do not present this one as a showcase of risk
checking; present it as a showcase of an audit line.

---

## If the first real paid call errors, read this before diagnosing anything

Written 2026-08-21, the night before a first paid call was plausible, so that it
is not diagnosed cold.

**Check for `authorization_already_used` first.** A single-flight guard binds one
x402 payment authorization to one transaction hash. A well-behaved client mints
a fresh authorization per request and never sees it. A client that reuses one
authorization across *different* hashes gets a refusal instead of a decode:

```json
{ "error": "This payment authorization was already used to explain a different
            transaction. Each payment covers one transaction; send a new payment
            for this one.",
  "code": "authorization_already_used" }
```

**That is correct behaviour, not a bug** — one payment buys one decode, and
without it a burst sharing one authorization would run N decodes for one payment.
But it would be a confusing first paid experience, so name it immediately rather
than letting someone hunt.

**Other things to check, in order:**

| Symptom | Look at |
|---|---|
| paid call refused as above | client reusing one authorization — see above |
| 402 loop, client never pays | they need an x402-capable client; a plain MCP client reads the challenge as an error, which is per spec |
| card purchase, no pass | `webhook.status` on `/stats` — if `REJECTING_SIGNED_DELIVERIES`, our secret disagrees with Stripe and Stripe retries ~3 days |
| paid but `revenue_from_customers_usd` still 0 | correct until a human promotes it. `/stats` → `unattributed[]` gives the exact handle to POST to `/revenue/attribute` |
| pass token answers `not_activated` after a deploy | a restart stranded it mid-settlement; `listUnconfirmed()` has it, with the nonce |

**The last two are by design and will look like bugs.** Revenue does not
self-promote and a stranded pass is not silently deleted — both under-report
until a human looks, which is the direction chosen deliberately.
