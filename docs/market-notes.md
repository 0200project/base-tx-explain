# Market notes (researched 2026-08-19)

## The gap this fills

Nobody sells a **one-call, deterministic, strict-JSON transaction explanation with risk
flags** that an agent can pay for without an account. The neighbors:

- **Blockscout MCP** (free) — closest free substitute; `transaction_summary` exists but
  is display prose with an LLM fallback (non-deterministic), no risk flags, no schema
  contract, API marked "in development", credit metering signals future paywalling.
- **Noves Translate** — closest incumbent; accounting-oriented classification, free
  demo-grade MCP, then a $250–500/mo enterprise cliff. No per-call option, no risk flags.
- **anchor-x402** — closest x402 competitor ($0.001–0.05/call); decode-level (calldata),
  not explanation-level; no assets/counterparties/risk in one call.
- **Etherscan API** — removed free-tier Base access mid-2026 (now $49+/mo). Every
  free-tier Base user just got orphaned; raw data only, no explanation layer.
- **Alchemy/Moralis MCPs** — free but account+key required, raw/enriched data only.
- **Tenderly** — human debugger, ~$80–100/mo class, traces not narratives.
- **GPT55/token-safety x402 tools** — risk verdicts on approvals/tokens ($0.0001–0.05),
  fragmented; an agent needs 3–5 vendors to reconstruct one transaction.

## Pricing verdict

$0.02/call sits comfortably inside the live x402 band ($0.001–$0.05) for a tool that
replaces 3–5 fragmented calls; $9/mo marketplace tier undercuts every subscription
neighbor by an order of magnitude. No change recommended.

## Positioning line

"Your agent's LLM shouldn't reason over raw logs. One call, one strict JSON answer,
deterministic, pay-per-use, no account."

## Moat honesty

Thin, by design — the plan is portfolio velocity, not defensibility. Blockscout could
ship this free; the bet is that a stable schema + risk flags + x402-native payment +
zero signup is a durable-enough wedge for a micro-tool, and that the same wrapper
amortizes across the next tools (xrpl-intel, etc.).

## Who the pass is actually for (2026-08-21, from a real declined sale)

Circadian-agent (a real, technically sophisticated x402/MCP researcher, verified our
decode field-by-field before answering) declined the $9/30-day pass with a number, not
a feeling: 24 distinct tx hashes verified across 24 days of operation, ~$7.30/year at
per-call pricing, per-call beats the pass for them by roughly 25x. Their own framing,
worth keeping verbatim because it's sharper than anything we'd derived internally:

> "Any agent that verifies its own settlements will look like this: one lookup per
> payment, forever. If the pass is aimed at agents rather than at developers, that
> ratio is the thing to price against, and it means the agent segment converts to a
> pass only when it is doing analysis of OTHER PEOPLE'S transactions rather than
> accounting for its own."

**Implication for targeting:** an agent that verifies its own payments is structurally
bounded by its own payment frequency, not curiosity — it can never be a pass buyer no
matter how well-funded or engaged it is. The pass fits something analyzing transactions
it did not make: a block explorer, a research/monitoring agent watching third-party
wallets, a security tool auditing counterparties. Growth outreach for the pass
specifically should target that shape, not "any x402-native agent that engaged well."
Per-call pricing remains the right pitch for self-accounting agents like Circadian.
