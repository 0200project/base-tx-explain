# Launch posts, final paste-ready versions

Post from the 0200project identity (Reddit: u/polaris0028 is fine, aged + clean).
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

Pricing, honestly: 50 free calls per IP per 24h (shared by everyone behind one address, resets daily), then $0.02/call in USDC on Base via x402. The 402 response contains everything a paying agent needs to retry autonomously, no account or API key. An Apify Store listing with flat pricing is pending review.

Endpoint: `https://api.0200project.com/mcp` (streamable HTTP)

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
50 free calls a day, then $0.02/call USDC on Base via x402. A paying agent handles the 402 and retries with no signup and no API key.

Endpoint + repo: https://github.com/0200project/base-tx-explain

(Posting strategy: the thread is a formality from a day-zero account. The real X play is replies into active @CoinbaseDev and @x402daily threads where the audience already is. Showing up as a live seller on x402scan is worth more than the thread.)

---

## 3. Community MCP Discord (discord.me/mcp, showcase/servers channel, from polaris0028)

Built a small paid MCP server and would appreciate eyes on it: base-tx-explain. One tool, explain_transaction(tx_hash) for Base mainnet. Plain-English summary plus strict JSON (assets moved, labeled counterparties, risk flags, gas in USD). Deterministic decode only, no LLM in the response path, so the output contract is stable enough to parse blind. 50 free calls a day, then $0.02/call via x402. Repo: https://github.com/0200project/base-tx-explain. Feedback on the schema very welcome, especially from anyone building trading or wallet agents.

---

## 4. r/modelcontextprotocol (post 24-48h after the r/mcp post, so 2026-08-21)

**Title:**

How I monetized an MCP server with per-call USDC payments (x402): the wiring, the bugs, and honest day-one numbers

**Body (paste in Markdown editor mode):**

Disclosure: this is about my own server, base-tx-explain. Posting because the payment wiring took longer than the product and I'd have paid for a writeup like this.

The pattern: the server stays a normal streamable-HTTP MCP server. A payment wrapper sits around the one tool handler. First N calls per client are free. After that, the tool result IS the payment challenge: an x402 402 body with the price in atomic USDC units, the receiving address, and the network, returned in-band. A paying client attaches the signed payment at `_meta["x402/payment"]` and retries the same call. No accounts, no API keys, settlement is on Base via a facilitator. The client side needs no ETH for gas (EIP-3009 transfer authorization).

Three bugs I hit that anyone copying this pattern should check for:

1. Trusting the whole X-Forwarded-For chain. With `trust proxy: true` in Express, any client mints a fresh free tier per request with a forged header. Trust exactly one hop, or read your host's client-IP header. My paywall was decorative until this was fixed.

2. Batched JSON-RPC. Old-protocol clients can send an array of tools/call in one request. My gate consumed one free call for the whole batch. N decodes for one credit. Reject batches or meter per call.

3. Charging for errors. Check what your payment wrapper does when the tool returns isError. Mine (the x402 MCP wrapper) cancels settlement on error results, which is correct, but I only knew that after reading the wrapper source. A buyer paying for "upstream RPC timed out, retry" twice is how you lose the only payers you have.

Honest numbers, day one: validation suite says 95/100 recent Base transactions decode clean with zero crashes. One stranger has found the server and is working through the free tier. Paid calls from strangers: zero so far. The kill criterion is written down: no paid calls by day 14 means I ship the next tool on the same rails instead of polishing this one.

Question for this sub: if you run agents that consume paid tools, what actually makes you willing to let the agent pay per call: price under some threshold, a spend cap on your side, a trust signal on the seller, or something else?

---

## Later waves (not day one)
- r/AI_Agents: the "my agent discovers and pays for an API by itself" demo angle. Looking-for-testers framing, not launch framing.
- r/ClaudeCode (flair: Built with Claude): lead with the failure mode (agent asked "what did this tx do", pasted raw logs, hallucinated an answer), then the fix.
- Anthropic Discord Featured Projects channel plus the build-submission Typeform.
