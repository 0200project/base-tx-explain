# Live customer pipeline — 2026-08-21

Mission (updated 19:28Z, founder directive): 10 paying customers at $9/month today. $90 MRR target. Distribution and closing, not more research. Funnel: prospect → conversation → trial → checkout → paid.

**Scoreboard: 0 / 10 paid. $0 / $90 MRR.**

## Active

| Prospect | Why they might need 0200 | Contact channel | Status | Objection | Next action | Trial / checkout / payment |
|---|---|---|---|---|---|---|
| DeFiHackLabs (SunWeb3Sec) | Reads attacker tx hashes for PoC repos | GitHub issue #1212, one question, no pitch | Sent 18:05Z, silent | — | Wait; too soon to follow up. Their own tooling likely already decodes (strongest-no from research) | No trial, no checkout |
| ChainAware.ai | On-chain intelligence product, address-keyed today | GitHub issue #6, one question, no pitch | Sent 18:05Z, silent | — | Wait; too soon to follow up. They run their own on-chain infra (strongest-no) | No trial, no checkout |
| Sharpe Labs | Base rug-check page, no tx-hash endpoint in their API | Telegram to @SharpeAI_Official, sent by founder | Silent (no visibility into this channel from here) | — | Ask founder to check for a reply | No trial, no checkout |
| SCVD General Store (Record Creative Co. LLC, solo-run) | Independent attestation of what other people's x402 payments actually did, settling on Base among other chains — literally our decode's job, one layer up. Already runs real x402 payments in production. | GitHub issue #188, one question, no pitch | Sent 18:27Z, silent | — | Wait; too soon to follow up | No trial, no checkout |
| Counterra (billiondollarapps, solo) | Reads Base+Solana x402 settlements to build accounting books for AI agents. Real gap: gas fee in USD as its own journal line, reverted settlements excluded from disposal count. Onboarding 2-3 free design partners — real reciprocal-value opening. | GitHub issue #9 + follow-up comment (bug disclosure: our own reverted-but-valued phantom-movement fix) | Sent 18:41Z, silent | — | Wait; too soon to follow up | No trial, no checkout |
| AgentPay MCP (up2itnow0822, solo/small team) | Open-source non-custodial x402 payment layer for agents. Their own get_transaction_history only returns recipient/amount/block number, no decode of what a swap/bridge action did. | GitHub issue #48, one question, no pitch | Sent 19:15Z, silent | — | Wait; too soon to follow up. Platform prepped a concrete before/after decode example (Circadian's real settlement) as a follow-up if they engage. | No trial, no checkout |
| PulseFeed (Nikolife2016/O_Nikolife, solo) | Live x402 trust/safety oracle verifying OTHER endpoints before an agent pays them — repeated third-party analysis, good $9/mo pass shape. On-chain check is address-level history, not per-settlement decode. | GitHub issue #26, one question, no pitch | Sent 19:23Z, silent | — | Wait; too soon to follow up | No trial, no checkout |

## Closed

| Prospect | Why they might need 0200 | Contact channel | Status | Objection | Next action | Trial / checkout / payment |
|---|---|---|---|---|---|---|
| Circadian-agent | Verified decode field-by-field, ran real in-band payment as unpaid favor | GitHub issue #5, full technical relationship | Closed | Volume too low for the pass; per-call beats it by ~25x at their own volume, their own math | Do not re-pitch; relationship stays open for engineering correspondence only | Free-tier + 1 real per-call settlement (favor, not revenue). No pass. |

## Findings driving today's search

- Segment research (docs/segment-research-2026-08-21.md): 0/7 named volume-buyer targets survived. Real signal: **outreach converts engagement, organic discovery has produced zero returning strangers.**
- The $9/mo pass fits agents analyzing OTHER parties' transactions repeatedly (a third-party auditor, monitor, or trust oracle), not agents settling and verifying their own spend — that segment structurally prefers per-call (Circadian's own math). PulseFeed and Counterra are the closest pass-shaped fits found so far for that reason; AgentPay MCP is closer to a per-call fit (their own agent's own spend).
- Response rate on all 7 threads so far: 0%. None are old enough yet (oldest 83 min) to warrant a follow-up without reading as impatient.

## Log

- 2026-08-21: Broad discovery search (Reddit r/ethdev, r/CryptoCurrency, r/base; HN Algolia) confirmed the research's core finding live — acute "I need this now" posts don't exist; what exists is builders making their own decoders (criteria-2/3 tension) or off-topic noise. Pivoted to precision search inside the x402/MCP ecosystem itself, the one population that already trusts this payment model.
- Checked pollar-xyz (recently very active Base-adjacent-looking repo): disqualified, they're live on Stellar/Solana, not Base, brand-new repo.
- Found SCVD General Store: strong structural fit, drafting outreach.
- Checked all 4 open threads (DeFiHackLabs #1212, ChainAware #6, SCVD #188, Sharpe Labs Telegram): still silent.
- Found Counterra (billiondollarapps/counterra): solo accounting-for-x402-agents tool. README review corrected the initial pitch angle (a settlement doesn't carry "what was purchased" on-chain); sent a narrower, honest question about gas-fee-in-USD and reverted-settlement handling in their journal entries. github.com/billiondollarapps/counterra/issues/9
- Platform live-verified both Counterra asks against real Base transactions and found a genuine disclosure: our own decoder had a bug (fixed today, b1baeac) where a reverted-but-valued transaction reported a phantom asset movement (EVM refunds it, but the value is still on the tx object, and logs are discarded on revert). Posted as a follow-up comment on issue #9, framed as disclosure not diagnosis, no pitch.
- Founder asked directly whether we'd gotten a customer yet. Verified from scratch rather than trusting the dashboard: 10-day on-chain RPC scan of the payout wallet found exactly 2 USDC transfers ever, both known non-revenue; card rail webhook `never_exercised`; 0 new external clients since the marker shipped. Answer: no. A Stripe webhook rejection that looked alarming ("customer may have been charged") turned out to be platform's own test harness, confirmed directly by them.
- Ran a 6-modality discovery workflow (GitHub accounting/tax search, web search, x402 ecosystem directories, MCP registries, fresh GitHub topic activity, Base builder ecosystem) for the next prospect: 13 raw candidates, ~50 documented dead ends. The accounting/tax segment (flagged earlier as unexplored) came back essentially empty. Top-ranked candidate's key claim (an NVIDIA integration) turned out to be fabricated on independent verification; found AgentPay MCP as the strongest candidate that survived fact-checking and sent outreach (issue #48).
- Verified and sent outreach to PulseFeed, #2 candidate from the sweep (issue #26). One claim from the original research ("pays real USDC to probe") didn't hold up on reading their actual methodology page; the real, defensible gap (on-chain receiver check is address-level history, not per-settlement decode) survived and became the question asked.
- `first_interaction` risk check dark 2h today: confirmed external (Blockscout fully down, not our bug), core decode unaffected (runs on Base RPC), and the checks object degraded honestly (unavailable, not falsely clean) exactly as designed. No fix needed, clears when Blockscout does.
- 19:28Z: Founder raised the target to 10 paying customers at $9/mo today ($90 MRR), distribution/closing not research. Restructured this doc to the new column spec, dogfooded /pass live (clean 402, correct terms, no friction found), synced platform/accountant/surface on the new target.
