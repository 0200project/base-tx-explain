# Launch posts — drafts

Three drafts, one per channel, written to each channel's norms (researched 2026-08-19).
Post from the plainoutput identity only. No emoji, no hype adjectives, show real output.
Do not post to r/LocalLLaMA; do not pitch in the official MCP contributor Discord.

---

## 1. r/mcp — flair: Showcase — post first

**Title:** I built an MCP server that explains any Base transaction in plain English — deterministic decode, no LLM in the response path

**Body:**

Disclosure: I built this and it charges per call after a free tier.

One tool: `explain_transaction(tx_hash)`. You give it a Base mainnet transaction hash,
it returns strict JSON: a 1–3 sentence summary, an action type, every asset that moved,
counterparties (labeled where known — routers, bridges, marketplaces), risk flags
(unverified contract, unlimited approval, approval-for-all, known-drainer match,
reverted), gas in USD, and a Basescan link.

The part I care about: there is no model anywhere in the response path. It's a pure
onchain decode — receipt logs through ~40 builtin event decoders (ERC-20/721/1155,
Uniswap V2/V3/V4, Aerodrome, Seaport, Aave, OP-stack bridges, ERC-4337, EAS), verified
ABIs from Sourcify for app-specific events, deterministic classification rules. Same
hash in, same JSON out, nothing to hallucinate. The point is that your agent's LLM
shouldn't have to reason over raw logs (and burn tokens doing it) when the decode is
mechanical.

Example output for a real swap:

```json
{
  "summary": "0x401d...f2c5 swapped 0.03 ETH for 12,899,422 WNL via Uniswap V4 PoolManager.",
  "action_type": "swap",
  "risk_flags": [{ "flag": "unverified_contract", "detail": "The target contract 0xd0a4...e4bf has no verified source code on Sourcify." }],
  "gas_paid_usd": 0.020562
}
```

(assets_moved / counterparties / timestamp trimmed here for length — full schema in the README)

Validated against 100 random recent Base transactions before shipping: 93% decode to a
specific action type, the rest degrade to an honest partial summary, zero crashes.

Pricing, honestly: 10 free calls per client, then $0.02/call in USDC on Base via x402 —
the 402 response contains everything a paying agent needs to retry autonomously, no
account or API key. There's also a flat-rate hosted version on Apify.

Endpoint: `https://base-tx-explain.fly.dev/mcp` (streamable HTTP) — repo: github.com/plainoutput/base-tx-explain

Things I'm unsure about and would genuinely take corrections on: the action-type
taxonomy (30 types currently), whether `partial: true` semantics are right for agents,
and which protocols beyond the current label table matter most on Base.

---

## 2. X — same day, thread of 3

**Tweet 1:**
Your agent shouldn't burn tokens reasoning over raw EVM logs.

base-tx-explain: one MCP tool. Base tx hash in → strict JSON out: plain-English summary,
assets moved, labeled counterparties, risk flags, gas in USD.

Deterministic decode. No LLM in the response path.

**Tweet 2 (screenshot of the real JSON output from the README):**
Real output, real tx. 93/100 random recent Base txs decode clean; the rest fail
gracefully with an honest partial. Zero crashes.

Risk flags included: unverified contract, unlimited approval, approval-for-all,
known-drainer match.

**Tweet 3:**
10 free calls, then $0.02/call USDC on Base via x402 — a paying agent handles the 402
and retries with no signup, no API key. Also hosted flat-rate on Apify.

MCP endpoint + repo: github.com/plainoutput/base-tx-explain

(When posting: quote-tweet or reply into active x402 threads — @CoinbaseDev Bazaar
threads, @x402daily — rather than shouting into an empty timeline. Showing up as a live
seller on x402scan is worth more than the thread itself.)

---

## 3. Community MCP Discord (discord.me/mcp — showcase/servers channel)

Built a small paid MCP server and would appreciate eyes on it: base-tx-explain — one
tool, `explain_transaction(tx_hash)` for Base mainnet. Plain-English summary + strict
JSON (assets moved, labeled counterparties, risk flags, gas USD). Deterministic decode
only — no LLM in the response path, so the output contract is stable enough to parse
blind. 10 free calls, then $0.02/call via x402 (or flat-rate on Apify). Repo:
github.com/plainoutput/base-tx-explain — feedback on the schema very welcome,
especially from anyone building trading or wallet agents.

---

## Later waves (not day one)

- **r/modelcontextprotocol** (24–48h later, reworded): frame around "how do you monetize
  an MCP server" — the x402 per-tool payment wrapper pattern is the story, the tool is
  the example.
- **r/AI_Agents**: "my agent discovers and pays for an API by itself" demo angle —
  looking-for-testers framing, not launch framing.
- **r/ClaudeCode** (flair: Built with Claude): lead with the failure mode — agent asked
  "what did this tx do", pasted raw logs, hallucinated an answer — then the fix.
- **Anthropic Discord** Featured Projects channel + the build-submission Typeform.
