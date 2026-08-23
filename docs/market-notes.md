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

## Second independent confirmation, and the repricing decision it triggered (2026-08-22/23)

kindrat86/agentmail — a real compliance-tooling maintainer who actually ran the
decoder, judged the output "a much better integration boundary than parsing a
narrative response" — landed on the identical conclusion from an integration
judgment rather than arithmetic: per-call fits an occasional, self-triggered
verification path (their `dispute_open`), a subscription doesn't. Two independent
technical evaluators, two different reasoning paths, same answer. That's a pattern,
not a coincidence, and segment research §4 names the underlying cause directly:
**the unit of sale was wrong for both of them, not the price.** Cutting the number
doesn't fix a structural mismatch — Circadian's own math shows even a much cheaper
pass loses to per-call at their volume.

**The break-even, so this is checkable in a conversation rather than argued about:**
$9 / $0.02 = **450 calls per 30 days.** Below that, per-call wins, full stop, no
pass pitch belongs in that conversation. Above it, the pass is the better deal and
should be led with, not offered as an afterthought.

**Who's above the line, per §4:** continuous third-party analysis — compliance
tools screening a fixed list of addresses, forensics/investigation work processing
batches of hashes, portfolio/wallet trackers, block explorers, DAO treasury
monitors (§4 flags this last one as unverified by primary source — treat as a
hypothesis, not a qualified lead). The shared shape: volume that scales with
*something other than the agent's own transaction frequency* — a client list, a
watchlist, a corpus to process.

**What the pass is honestly NOT, and must not be pitched as:** a standing
watchlist with alerts. §4 names "per-address watchlist, monthly" as the ideal unit
of sale, but that describes a **product we have not built** — proactive
monitoring of a given address with push notifications. What we actually sell today
is 10,000 calls over 30 days, pull-based, no alerting. That's genuinely valuable to
anyone already above the 450-call/month line, and should be sold as exactly that —
not oversold as monitoring infrastructure that doesn't exist. If the founder wants
the real watchlist product built, that's a platform/engineering decision, distinct
from this repricing.

**Practical screen for future outreach:** ask (or infer from what they've already
described building) whether their tool's call volume scales with their own
payment/dispute frequency (per-call pitch, skip the pass entirely) or with a
list/corpus size larger than one (lead with the pass, cite the 450-call breakeven
directly). Getting this right before drafting saves a wrong-tier pitch and the
correction that follows it.
