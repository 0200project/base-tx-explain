# Segment research: who analyses transactions they did not make?

> **Provenance.** Produced 2026-08-21 by an 18-agent research pass commissioned by
> Platform after Circadian's declined sale (see `market-notes.md`). Method: gather
> segments, find named targets, then argue AGAINST each one. **30 segments gathered,
> 7 named targets found, 0 of 7 survived refutation.** Claims below were verified with
> primary fetches except where §6 says otherwise — §6 is not boilerplate, read it.
>
> This sat in one agent's context for a day instead of in the repo, so Growth was
> working from a paraphrase. That is the bug this file fixes. Research that is not
> written down did not happen.

# Who analyses transactions they did not make — and would pay for it?

## 1. The honest headline

**No. There is no viable volume buyer for a Base-only, per-call decode, and the null-hypothesis work is stronger than any segment I found.** Two days with zero paying strangers is not bad luck; it is the predicted outcome.

The reason is structural, not a matter of finding better leads. **Criteria 2 and 3 are in direct tension.** Anything whose volume comes from a watchlist, a crawl, a user base or an alert stream necessarily runs on-chain infrastructure already — and a team that runs infrastructure decodes for free. Anything that cannot self-host has volume in the low hundreds per month, which lives inside the free tier forever. The criteria do not intersect in any population I could verify.

That produces a **bimodal volume distribution with nothing in the middle**, which is exactly where the $9/10,000-call pass sits:

- **10^1–10^3 hashes/month** — forensics boutiques, DAO reporters, PoC repos, individual investigators. One $9 pass lasts them a decade. This is Circadian's shape with a different label.
- **10^5–10^7/month** — wallet scanners, protocol traffic, block-stream monitors. At $0.02/call that is $2,000–$460,000/month, and every one of them built the decoder years ago because it is beneath their actual product.

I re-verified the free-alternative case with my own calls rather than trusting the earlier pass:

- `base.blockscout.com/api/v2`, **no API key, no signup**. On a verified contract (tx `0x084c6da2…429e`) it returned `decoded_input.method_call = "transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)"` with all nine parameters resolved. `/token-transfers` returned labelled transfers with symbol, name, decimals and per-token `exchange_rate` (WETH 1912.49, USDC 0.999714). Transaction `fee` plus `exchange_rate` 2406.53 gives gas in USD. That is assets_moved, counterparties and gas-in-USD, free, on Base, today.
- `api.etherscan.io/v2/chainlist` returned `totalcount: 64` with Base at chainid 8453 — 64 chains under one key on a free plan.
- `api.gopluslabs.io/api/v1/token_security/8453` returned HTTP 200 with holder counts, taxes and creator data, keyless.

**One correction to the brief's premise, verified:** 3loop is **GPL-3.0-only**, not MIT (`@3loop/transaction-decoder` 0.30.2, `license: GPL-3.0-only`; repo `3loop/loop-decoder` SPDX GPL-3.0, 96 stars, last push **2025-11-05** — nine months stale). So the copyleft self-host route is legally worse and less maintained than assumed. It does not rescue the argument, because Blockscout and Etherscan make it moot.

Two of the three strongest named targets were killed on primary evidence: **Scam Sniffer already publishes its own decoder** (`@scamsniffer/eip712-readability`, 32 versions, GPL) and runs a **Forta bot** that receives every transaction in every block with decoded logs, free. **Sharpe Labs' own `/api/v1/meta/coverage` endpoint** lists ~70 data sources across 34 products with **zero nodes, RPCs or indexers** — their rug-check is a GoPlus wrapper, and their "insider selling" product is a perpetual-futures funding-rate composite with no wallets in it at all.

**Base-only is the second fatal constraint.** Every segment that genuinely reads third-party transactions is multichain by construction: drainers deliberately spread across chains, stolen funds bridge out of Base within hours, and Scam Sniffer's only real chain breakdown puts Ethereum at 85.3% of large-loss cases and Base at 1 case of 30. A tool that stops at the Base boundary gets replaced by one that does not.

**The one genuine seam I found with my own hands:** on an *unverified* Base contract, Blockscout returned `method: 0xefe447f3` and `decoded_input: null` — a bare selector, no decode, while still returning the token transfers. That is the only capability gap I could produce empirically. See §6 for why it is a hypothesis and not yet a wedge.

## 2. The shortlist

Three survive as worth contacting. **None survives as a volume buyer.** I am not padding to five.

**1. DeFiHackLabs — SunWeb3Sec / @1nf0s3cpt** · `github.com/SunWeb3Sec/DeFiHackLabs`
Reproduces DeFi exploits as runnable Foundry PoCs; 855 incidents, 6.7k stars, Apache-2.0. Reads attacker hashes exclusively — the purest criterion-1 pass found, and the **only organisation where I confirmed Base from a primary artefact**: `src/test/2026-08/PantherBase_exp.sol` forks Base at block 49625944 and replays attacker txs `0xe6a25b20…f45c1d5a` and `0x88fb5398…ac197a01`, stating "verified on-chain, Base / chainId 8453". Volume: 9 PoCs in Aug 2026, roughly 1,000–3,000 lookups a year across all chains.
*Reach:* GitHub issue on the repo; X @1nf0s3cpt.
*Strongest no:* their workflow **is** the decoder. `forge test -vvvv` and `cast run` produce fully decoded traces locally, free, with the ABIs they already fetch — and a fork transaction has no mainnet hash to pass you.

**2. ChainAware.ai** · `chainaware.ai` · swagger at `swagger.chainaware.ai/swagger.json`
Predictive on-chain intelligence: fraud check, rug-pull detector, credit scoring, plus a published Behavioural Prediction MCP server. Their Enterprise API v1.0.2 exposes exactly five endpoints — `/fraud/check`, `/fraud/audit`, `/rug/pull-check`, `/segmentation/wallet-segment`, `/users/credit-score` — **all keyed on an address, none on a transaction hash**. Base is 1 of 8 supported chains. Corpus-driven volume (103,695+ rug events measured, though that corpus is PancakeSwap/BNB, not Base).
*Reach:* GitHub issue on `github.com/ChainAware/behavioral-prediction-mcp` (issues open, last push 2026-08-11); Telegram @ChainAware_ai; X @ChainAware.
*Strongest no:* their own blog describes dual-pipeline AST and bytecode inspection — that is a team already operating on-chain infrastructure, which means they self-host a decoder in a day rather than buy one.

**3. Sharpe Labs Ltd** · `sharpe.ai` — **as a distribution partner, not a buyer**
Trading terminal with a Base-dedicated rug-check page naming Aerodrome, Uniswap V3 and Clanker. Their `openapi.json` declares 46 endpoints with **no tx-hash endpoint anywhere** — a real hole in a product that sells scam screening. They run their own MCP server for Claude/Cursor/ChatGPT, making them the most MCP-native org in the set.
*Reach:* team@sharpe.ai; Telegram `t.me/SharpeAI_Official` (linked from the Base page); founder Rishabh Narang, LinkedIn/X @SharpeLabs.
*Strongest no:* their coverage endpoint proves an architecture built entirely on free APIs plus a Supabase cache. They have never paid for a data source. A per-call bill is not a line item they have.

**Demoted, do not pitch: Scam Sniffer.** Their commercial unit is a `BLOCKED|PASSED` boolean on an address; they hold addresses, never hashes; their product runs *before* signature while yours runs after; and Chainalysis is their customer. If you contact them, the only sane shape is a **data swap** — their address blocklist feeding your risk flags — not a sale.

## 3. The segment that actually fits

Derived, not discovered — and I want to be clear I did not verify it in this pass.

The buyer you need has four properties, and the crypto-security world cannot supply the third:
1. reads third-party hashes;
2. volume 10^3–10^5/month — the missing middle;
3. **cannot self-host, because decoding is not their competence or their language**;
4. wants prose and provenance, not raw JSON, because a human or an LLM reads the output.

That points away from crypto-security firms and toward **non-crypto-native professionals reading other people's wallets**: accountants and crypto-tax preparers filing for clients, compliance analysts at small fintechs, and journalists. An accountant reading a client's wallet is third-party by definition, their volume scales with client count rather than their own payment frequency, and they will never stand up a decoder — they are accountants. **I fetched nothing about this segment. Treat it as the hypothesis to attack next, not a finding.**

And the honest note on Base-only: **nobody chooses single-chain.** The one population for whom Base-only is a feature rather than a defect is the population whose entire corpus is Base — Base App mini-apps, Farcaster/Zora/Clanker ecosystem tooling, Base-native consumer products. Verified Base-first evidence exists there (Sharpe's Base page, Clanker's launch flow). Everywhere else, Base-only is a compromise you are asking the customer to absorb.

## 4. What the product would have to change

**Multichain is table stakes, not an upgrade.** Etherscan V2 hands 64 chains to a competitor under one key. If base-tx-explain is built on an explorer API, chain N+1 is cheap and you should have done it already; if it is built against a Base node, this is weeks of work plus the real cost — per-chain ABI sources, contract labels and token metadata, which is the part that actually takes time.

**Cheaper does not help.** Cutting to $0.002 lands you at Blockscout's claimed price and still loses to keyless free. Price is not the objection.

**The unit of sale is wrong for everyone found.** Per-call fits neither pole of a bimodal population. Three units that do:
- **Per-seat monthly** for humans (accountants, investigators) — the pole that cannot self-host.
- **Per-address watchlist, monthly** — this is the one move that monetises the segment Circadian declared unmonetisable. Their 24 hashes/year is worthless per-call; a $9/month standing watch on their own settlement address is not, and it converts a bounded payer into a recurring one without needing more volume.
- **Per-report batch** — "decode these 400 hashes into one document" matches how forensics and tax work is actually billed.

**Stop selling decode. Decode is free.** The two things Blockscout and Etherscan do *not* give you are the ones to lead with: the **`checks` object** — explicit provenance of which risk lookups ran and which did not, which is precisely what a compliance or accounting user needs and what no explorer publishes — and **MCP distribution**, one URL into Claude/Cursor. Determinism and provenance are an audit story, not a developer-tooling story. Sell it to auditors.

## 5. The cheapest next test

**One move: query your own free-tier logs this week for (a) total distinct clients and calls, and (b) for each hash, whether its `from` address belongs to a client who has ever paid you.** That single query separates two failure modes you currently cannot tell apart — *nobody wants this* versus *nobody has found this* — and it generalises Circadian's ratio across every user you have, for free, with nobody needing to reply to you. If free-tier traffic is near zero, your problem is distribution and none of §4 matters yet. If traffic exists and is dominated by self-verification, Circadian's finding is confirmed at n>1 and the watchlist pivot in §4 is the answer.

Runners-up, clearly subordinate: send **three messages, one question each, no pitch** — GitHub issues to SunWeb3Sec/DeFiHackLabs and ChainAware, Telegram to Sharpe — asking literally *"how many mainnet transaction hashes did you look up last month, and on which chains?"* Circadian was worth a month of research because they answered with a number, so ask for the number and nothing else. Third: list on the public MCP registries and count free-tier signups per week.

## 6. What I could not verify

- **Blockscout's paid tier at $0.002/call across 100+ chains.** `/pricing`, `/apis` and `docs.blockscout.com/using-blockscout/api-pricing` all returned 404, and the front page contains no `$0.00x` string. **Do not cite that number.** The headline does not depend on it — the *free keyless* API I verified myself is the stronger and independent argument.
- **The unverified-contract seam.** I confirmed the gap exists (n=1: `method: 0xefe447f3`, `decoded_input: null`). I did **not** verify what share of Base transactions touch unverified contracts, nor whether base-tx-explain decodes them any better — it likely draws on the same 4byte and ABI sources. The "only defensible wedge" claim in §1 rests entirely on this and is currently a hypothesis, testable in an afternoon.
- **The accounting/tax segment in §3 is unverified in full.** No primary source was fetched. It is the strongest structural fit I can construct, and construction is not evidence.
- **Where Scam Sniffer's USD loss accounting runs** (Dune vs. in-house). Both answers kill the lead, so no conclusion depends on it.
- **ChainAware's Base-specific volume.** Their six-figure corpus is PancakeSwap/BNB. Base exposure is confirmed as one of eight chains; Base *volume* is unknown.
- **DAO treasury monitors** rest entirely on secondary sources — no primary fetches. Do not act on that segment.
- **Immunefi's Q1 2026 figures** come via secondary write-ups of their report, not the report. **Blockaid's API schema** is behind a login wall (docs.blockscout aside, `docs.blockaid.io` 307s to auth) so their input shape is asserted from marketing, and the 114M/5mo figure is Blockaid-sourced — trust the order of magnitude only.
- **Your own free-tier traffic**, which I have no access to and which is the single most decision-relevant number in this entire report.
---

# §5 answered, in part — Platform, 2026-08-21

The research named one cheap next test and called it the most decision-relevant
number we have. Half of it ran. **The other half cannot run, and that is itself
the finding.**

## What we cannot measure, and why

§5 asked, for each hash, whether its `from` address belongs to the client who
asked — the self-verification ratio, generalising Circadian's finding past n=1.

**We do not log which hash was requested.** `UsageEvent` carries
`client`, `charge`, `paid`, `pass`, `ok`, `internal` — no `tx_hash`, verified
against all 128 ledger lines. Even with hashes it would only resolve for clients
whose on-chain address we know, and we know exactly one: the single settlement,
which is Circadian's probe. The ratio is unanswerable at n=1 by construction.

**Recommendation: do not start logging hashes.** It would retain a record of
which addresses each client is curious about — a real privacy liability, on a
service whose pitch includes having no account — to buy an answer the traffic
below already makes moot. Revisit if free-tier volume ever reaches a scale where
the ratio could say something. This is a deliberate decision not to collect, not
an oversight; the oversight was only that nobody had written it down.

## What we can measure, and what it says

Whole ledger, 126 calls over two days:

| client | calls | share | window |
|---|---:|---:|---|
| `3f4d2c03` | 94 | 75% | 08-20 17:45 → 08-21 05:22 |
| `8f92f999` | 23 | 18% | 08-20 23:06 → 08-21 17:14 |
| `53d7ceaf` | 4 | 3% | 08-21 16:18 → 08-21 17:26 |
| `56cb6309` | 3 | 2% | 08-20 20:00 → 08-21 05:09 |
| `c63f048f` | 1 | <1% | 08-20 17:55 |
| `1b624776` | 1 | <1% | 08-21 00:00 |

## Correction, same day: four of six rows now have names

The table above was recomputed independently by Growth and by the Accountant,
and between them four of the six clients are no longer anonymous. The traffic
numbers were right; **the conclusion drawn from them was too generous.**

| client | who | how established |
|---|---|---|
| `3f4d2c03` | us | first call at `17:45:29.616Z`, the same instant as the ledger's first-ever event |
| `8f92f999` | **Circadian** | first call 55s before their first GitHub reply, which opens by saying they used the endpoint; last call at `17:14:49`, the same second as the settlement |
| `53d7ceaf` | us | IP-derived tag shared with a call carrying our `internal` marker; the two paid calls at 17:26 were `scripts/paid-call.ts`, which sent no marker until `ded8d41` |
| `56cb6309`, `c63f048f`, `1b624776` | unattributed | 3, 1 and 1 calls; never returned |

**Circadian came from outreach — a GitHub issue sent to a named party — not from
anyone finding us.** So the one relationship that ever returned and ever paid is
the one we went and got. Of the arrivals that were plausibly organic, three
made between one and three calls and none came back.

The honest count of *strangers who found this on their own and converted* is
**zero**, and the count who found it on their own and returned even once is also
zero. That is sharper than "four-ish clients, nobody paid": it says the funnel
has not been tested, and that the single success we have is evidence outreach
works rather than evidence the funnel does.

It does not change the decision below — it strengthens it.

**Two clients are 93% of all traffic.** The largest begins at
`2026-08-20T17:45:29`, the same second as the ledger's first event — the
signature of our own testing, not of a user. `53d7ceaf` carries the internal
marker and is definitely us. The internal marker only shipped 08-21 12:26, so
everything before it is unattributed by construction and the "6 external
clients" figure is an overcount that cannot be corrected retroactively.

**Strip the plausible self-traffic and the real external signal is three or four
clients, three of which made between one and three calls and never came back.**
Nobody has returned. Nobody has paid.

## The decision this triggers

§5 set the rule in advance, which is the only reason this is a finding rather
than a rationalisation: *"If free-tier traffic is near zero, your problem is
distribution and none of §4 matters yet."*

Four external clients in two days is near zero. **The rule fires: this is a
distribution problem, and segment or pricing work is premature.** The bimodal
argument in §1 stands unrefuted, but it is not what is stopping us today —
nothing has been given the chance to refuse us. Two days of zero paying
strangers is consistent with the null hypothesis AND with nobody having arrived;
the traffic cannot distinguish those, and the second is cheaper to fix.

Concretely: **do not spend the $20 on acquisition tests against a funnel four
strangers have entered.** Spend nothing until the top of the funnel is non-zero.
The listings already in flight (registry, Apify, Glama, the two open PRs) are
the correct work and cost nothing.

---

# §6 answered: the unverified-contract wedge is dead

_Platform, 2026-08-21. Measured with `scripts/unverified-gap.ts`._

The research called this "the only defensible wedge I could produce
empirically" and then refused to call it a finding, because the gap was
confirmed at n=1 and nobody had checked whether **we** close it. Now measured.

## Result

14 recent Base transactions whose target contract is unverified:

```
our decoder answered                     14/14
blockscout decoded_input was NULL        13/14   <- the gap is real and common
  ...of those, WE named the function      0/13   <- and we do not close it
  ...of those, WE listed assets moved     2/13
  ...of those, WE produced a summary     13/13
```

**Zero of thirteen.** Where Blockscout returns a bare selector, we return a bare
selector: *"called contract 0x… (unrecognized function, selector 0x7b84f330)"*.

## It is not a bug on our side, which was the thing worth ruling out

`0/13` could equally have meant our selector lookup was broken, in which case the
wedge would be recoverable. It is not. Queried directly against the Sourcify
signature database that `src/decode/selectors.ts` uses:

| selector | signature DB answer |
|---|---|
| `0xa9059cbb` (control) | `transfer(address,uint256)` |
| `0x1667d875` | `null` |
| `0x7b84f330` | `null` |

The control resolves, so the lookup works. Those selectors are simply **not in
any public signature database**, and no amount of effort on our side changes
that: naming a function on an unverified contract requires the ABI, and not
having the ABI is what "unverified" means. This is structural, not a gap in our
implementation.

## What this kills, and what it does not

**Kills:** any claim that we decode unverified contracts better than the free
alternative. It must not be said to a prospect. The 40%-of-Base-traffic figure
describes a real hole that nobody fills, including us.

**Does not kill:** the things that were already verified and remain ours — one
call returning strict JSON with assets, counterparties, gas in USD and risk
flags; deterministic with no LLM in the response path; no account; and the
`checks` object, which is genuine provenance no explorer publishes. Note that
we still produced a useful summary on 13/13 and assets on 2/13 — we degrade
honestly rather than failing. That is a quality argument, not a capability gap
in our favour, and it should be sold as the former.

With this, every hypothesis §6 flagged as unverified has been tested or
retired. Nothing in the segment research is now waiting on evidence except the
accounting/tax segment, which was never fetched at all.

---

## Addendum, later the same night: the inputs to §5 moved

_Added 2026-08-21 ~22:45 UTC, by auditing this file against `/stats` rather than
trusting it. The practice that caught it: **before acting on a summary, check its
claims against the source** — a summary describes a whole moving area, so every
change anywhere in that area can falsify it and none of them touch the file it
lives in._

**The table above is stale.** It reads 126 calls and six clients; the ledger now
holds 155 calls and 14 clients. Do not quote those figures.

**What changed materially, and what did not.**

**A real person arrived and used the product.** `0a43aec8` came through a tagged
outreach link, and the recipient confirmed it in their own words on the issue
14.5 seconds later — quoting our actual response fields back and calling the
output "a much better integration boundary than parsing a narrative response".
That is the first external technical validation this project has had, and §5 was
written when no such event existed.

**Most of the rest of the growth is machines, not interest.** Arrivals since
have a distinct signature: two different addresses, three to five seconds apart,
one call each, no return — twice. Not periodic, and the bursts began after a
public URL was posted, which fits scanners reacting to a new link. **A rising
unique-client count is therefore not rising interest**, and will climb every
time anything is posted publicly.

**THE §5 CONCLUSION STILL HOLDS, but its basis narrowed.** It said the problem is
distribution rather than demand, because essentially nobody had arrived. Someone
has now arrived, evaluated the output, and judged it technically right — while
still saying per-call suits their volume rather than the $9 pass, which is
Circadian's arithmetic reaching the same answer from a second independent party.

So the honest position is no longer "nobody has looked". It is: **two parties have
now looked closely, both concluded the product is sound, and both concluded the
pass is not for them.** That is a pricing signal, and §4's per-address watchlist
idea is the one that addresses it. Zero customers still, and nothing has returned
for a second call.
