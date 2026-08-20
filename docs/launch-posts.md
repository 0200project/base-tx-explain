# Launch posts, final paste-ready versions

Post from the 0200project identity (Reddit: u/polaris28 is fine, aged + clean).
Verify the exact handle spelling against the real accounts before posting.
No emoji, no hype adjectives, no em-dashes. Show real output.
Do not post to r/LocalLLaMA; do not pitch in the official MCP contributor Discord.

---

## 1. r/mcp, flair: Showcase, post first

**Title:**

I built an MCP server that explains any Base transaction in plain English (deterministic decode, no LLM in the response path)

**Body (paste in Markdown editor mode):**

Disclosure: I built this and it charges per call after a free tier.

One tool: `explain_transaction(tx_hash)`. You give it a Base mainnet transaction hash and it returns strict JSON: a 1-3 sentence summary, an action type, every asset that moved, counterparties (labeled where known: routers, bridges, marketplaces), risk flags (unverified contract, unlimited approval, approval-for-all, known-drainer match, reverted), gas in USD, and a Basescan link.

The part I care about: there is no model anywhere in the response path. It's a pure onchain decode. Receipt logs run through ~40 builtin event decoders (ERC-20/721/1155, Uniswap V2/V3/V4, Aerodrome, Seaport, Aave, OP-stack bridges, ERC-4337, EAS), verified ABIs from Sourcify cover app-specific events, and classification is deterministic rules. Same hash in, same JSON out, nothing to hallucinate. Your agent's LLM shouldn't have to reason over raw logs and burn tokens doing it when the decode is mechanical.

Example output for a real swap:

```json
{
  "summary": "0x401d...f2c5 swapped 0.03 ETH for 12,899,422 WNL via Uniswap V4 PoolManager.",
  "action_type": "swap",
  "risk_flags": [{ "flag": "unverified_contract", "detail": "The target contract 0xd0a4...e4bf has no verified source code on Sourcify." }],
  "gas_paid_usd": 0.020562
}
```

(assets_moved / counterparties / timestamp trimmed for length, full schema in the README)

I validated against 100 random recent Base transactions before shipping. 95 decode to a specific action type, the rest degrade to an honest partial summary, zero crashes.

Pricing, honestly: 10 free calls per client, then $0.02/call in USDC on Base via x402. The 402 response contains everything a paying agent needs to retry autonomously, no account or API key. An Apify Store listing with flat pricing is pending review.

Endpoint: `https://base-tx-explain.fly.dev/mcp` (streamable HTTP)

Repo: https://github.com/0200project/base-tx-explain

Stuff I'd genuinely take corrections on: the action-type taxonomy (30 types right now), whether the `partial: true` semantics make sense for agents, and which Base protocols beyond my current label table actually matter.

---

## 2. X, thread of 3 (from the fresh 0200project account)

**Tweet 1:**
Your agent shouldn't burn tokens reasoning over raw EVM logs.

base-tx-explain: one MCP tool. Base tx hash in, strict JSON out: plain-English summary, assets moved, labeled counterparties, risk flags, gas in USD.

Deterministic decode. No LLM in the response path.

**Tweet 2 (attach screenshot of the JSON output from the README):**
Real output, real tx. 95/100 random recent Base txs decode clean, the rest fail gracefully with an honest partial. Zero crashes.

Risk flags included: unverified contract, unlimited approval, approval-for-all, known-drainer match.

**Tweet 3:**
10 free calls, then $0.02/call USDC on Base via x402. A paying agent handles the 402 and retries with no signup and no API key.

Endpoint + repo: https://github.com/0200project/base-tx-explain

(Posting strategy: the thread is a formality from a day-zero account. The real X play is replies into active @CoinbaseDev and @x402daily threads where the audience already is. Showing up as a live seller on x402scan is worth more than the thread.)

---

## 3. Community MCP Discord (discord.me/mcp, showcase/servers channel, from polaris28)

Built a small paid MCP server and would appreciate eyes on it: base-tx-explain. One tool, explain_transaction(tx_hash) for Base mainnet. Plain-English summary plus strict JSON (assets moved, labeled counterparties, risk flags, gas in USD). Deterministic decode only, no LLM in the response path, so the output contract is stable enough to parse blind. 10 free calls, then $0.02/call via x402. Repo: https://github.com/0200project/base-tx-explain. Feedback on the schema very welcome, especially from anyone building trading or wallet agents.

---

## Later waves (not day one)

- r/modelcontextprotocol (24-48h later, reworded): frame around "how do you monetize an MCP server". The x402 per-tool payment wrapper pattern is the story, the tool is the example.
- r/AI_Agents: the "my agent discovers and pays for an API by itself" demo angle. Looking-for-testers framing, not launch framing.
- r/ClaudeCode (flair: Built with Claude): lead with the failure mode (agent asked "what did this tx do", pasted raw logs, hallucinated an answer), then the fix.
- Anthropic Discord Featured Projects channel plus the build-submission Typeform.
