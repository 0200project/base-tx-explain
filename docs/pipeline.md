# Live customer pipeline — 2026-08-21

Mission: one real stranger discovers, understands, uses, and pays. Updated live.

## Active

| Prospect | Why they might need 0200 | Contact | Response | Objection | Next action | Paid |
|---|---|---|---|---|---|---|
| DeFiHackLabs (SunWeb3Sec) | Reads attacker tx hashes for PoC repos | GitHub issue #1212, one question, no pitch | Pending | — | Wait; their own tooling likely already decodes (strongest-no from research) | No |
| ChainAware.ai | On-chain intelligence product, address-keyed today | GitHub issue #6, one question, no pitch | Pending | — | Wait; they run their own on-chain infra (strongest-no) | No |
| Sharpe Labs | Base rug-check page, no tx-hash endpoint in their API | Telegram to @SharpeAI_Official, sent by founder | Pending | — | Wait | No |
| Circadian-agent | Verified decode field-by-field, ran real in-band payment as unpaid favor | GitHub issue #5, full technical relationship | Declined the $9 pass with real numbers (~$7.30/yr at their volume, per-call wins by ~25x) | Volume too low for the pass; per-call not worth pursuing further per their own math | Closed — do not re-pitch, relationship stays open for engineering correspondence only | No (and won't — respecting their answer) |

## Findings driving today's search

- Segment research (docs/segment-research-2026-08-21.md): 0/7 named volume-buyer targets survived. Real signal: **outreach converts engagement, organic discovery has produced zero returning strangers.**
- The one population where Base-only is a *feature* not a compromise: Base-native builders (Base App mini-apps, Farcaster/Zora/Clanker ecosystem) — unexplored tonight, worth a live sweep.
- Live, acute-need search (someone asking "what did this tx do" *today*) is untested and free — the fastest path to a real want, not a cold pitch to a company that likely self-hosts.

| SCVD General Store (Record Creative Co. LLC, solo-run) | Their core product is independent attestation of what other people's x402 payments actually did, settling on Base among other chains — literally our decode's job, one layer up. Already runs real x402 payments in production, so paying $0.02 is inside their comfort zone (unlike segment-research targets who'd never paid for a data source). | Sent: github.com/seancrecord/scvd-general-store-repo/issues/188 | Pending | — | Wait; check thread periodically | No |

| Counterra (billiondollarapps, solo) | Reads Base+Solana x402 settlements to build accounting books for AI agents ("financial telemetry for agent payments"). README review showed "what was purchased" isn't actually on-chain in a plain settlement, narrowed the ask to gas fee in USD as its own journal line and reverted settlements being excluded from the disposal count, both real receipt-level inputs their sweep may or may not already capture. Also explicitly onboarding 2-3 free design partners for feedback - real reciprocal-value opening. | Sent: github.com/billiondollarapps/counterra/issues/9 | Pending | — | Wait; check thread periodically | No |

## Log

- 2026-08-21: Broad discovery search (Reddit r/ethdev, r/CryptoCurrency, r/base; HN Algolia) confirmed the research's core finding live — acute "I need this now" posts don't exist; what exists is builders making their own decoders (criteria-2/3 tension) or off-topic noise. Pivoted to precision search inside the x402/MCP ecosystem itself, the one population that already trusts this payment model.
- Checked pollar-xyz (recently very active Base-adjacent-looking repo): disqualified, they're live on Stellar/Solana, not Base, brand-new repo.
- Found SCVD General Store: strong structural fit, drafting outreach.
- Checked all 4 open threads (DeFiHackLabs #1212, ChainAware #6, SCVD #188, Sharpe Labs Telegram): still silent.
- Found Counterra (billiondollarapps/counterra): solo accounting-for-x402-agents tool. README review corrected the initial pitch angle (a settlement doesn't carry "what was purchased" on-chain); sent a narrower, honest question about gas-fee-in-USD and reverted-settlement handling in their journal entries. github.com/billiondollarapps/counterra/issues/9
