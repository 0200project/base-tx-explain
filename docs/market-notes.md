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
