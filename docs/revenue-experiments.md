# Revenue experiments

Experiment backlog for base-tx-explain, grounded in the funnel the ledger
actually measures. `/stats` (token-protected) exposes: `free`, `wall_hits`,
`paid_calls`, `settlements`, `revenue_usd`, `unique_clients`. On-chain truth is
USDC arrivals at the payout address (Blockscout, tracked by `npm run growth`).

The funnel: discovery -> `free` calls -> `wall_hits` (the 402) -> `paid_calls`
-> `settlements` -> `revenue_usd`. The conversion that matters most is
`paid_calls / wall_hits`: of the agents that hit the wall, how many pay.

Baseline honesty: almost every number below is unknown until real strangers hit
the wall. Do not start experiments 1, 2, or 4 before roughly 20 organic
`wall_hits` exist; changing knobs on zero traffic teaches nothing.

## 1. Price point: $0.02 vs $0.01 vs $0.05

- **Hypothesis:** within the live x402 band ($0.001-$0.05), agent demand is
  price-insensitive, because the agent's alternative (an Etherscan subscription
  or 3-5 fragmented calls) costs more either way.
- **Change:** one env var on Fly and a redeploy; x402 carries the price in the
  402 challenge, so no client-side change exists. Run each price for a fixed
  window (7 days or 30 wall_hits, whichever comes second).
- **Metric:** `paid_calls / wall_hits` per price window, and `revenue_usd` per
  window. On-chain arrivals cross-check `settlements`.
- **Decision rule:** keep the price with the highest `revenue_usd` per
  wall_hit unless conversion at $0.05 drops by more than half vs $0.02.
  Conversion delta unknown until ~30 wall_hits per arm.
- **Effort:** trivial (env var). The cost is calendar time, not work.

## 2. Free-tier size: 10 vs 3 vs 25

- **Hypothesis:** 10 free calls is enough to prove the output contract to an
  agent developer; 3 may cut evaluation short, 25 may let small workloads
  finish without ever paying.
- **Change:** free-tier env var, same one-window-per-arm design as above.
- **Metric:** `free` vs `wall_hits` ratio (how many clients exhaust the tier),
  then `paid_calls / wall_hits`, and `unique_clients` (does a smaller tier
  scare off first contact).
- **Decision rule:** pick the tier that maximizes `paid_calls` without
  reducing `unique_clients` week-over-week. Unknown until roughly 50 unique
  clients have appeared.
- **Effort:** trivial.

## 3. The 402 hint text as a conversion surface

- **Hypothesis:** the 402 body is the only sales page a paying agent (or the
  human debugging it) ever reads. Clearer retry instructions raise
  `paid_calls / wall_hits` more than any price change.
- **Change:** rewrite the in-band 402 hint: state the exact price, the exact
  retry mechanics (attach payment at `_meta["x402/payment"]` and resend), that
  no account or key exists, and one line on what the paid call returns. A/B by
  alternating deploys weekly, or ship the clearer text and compare before/after.
- **Metric:** `paid_calls / wall_hits` before vs after; secondary, time between
  a client's first wall_hit and first paid call (derivable from logs).
- **Decision rule:** keep whichever text converts better over at least 20
  wall_hits per variant. Baseline conversion unknown until the first 20.
- **Effort:** small (copy change plus deploy). Do this one first; it needs no
  traffic threshold to ship, only to judge.

## 4. Per-client vs per-IP metering

- **Hypothesis:** per-IP metering hurts legitimate CI and shared-egress users
  (one NAT burns the whole team's free tier) and overcounts `unique_clients`,
  while making the wall trivially resettable for anyone with rotating IPs.
- **Change:** meter by a client-supplied identifier (MCP session or client
  info) with IP as fallback, rather than IP alone. Needs a design decision on
  spoofability: a self-declared ID makes the free tier infinite for a liar.
- **Metric:** `unique_clients` inflation (IP count vs client-ID count),
  wall_hits from addresses that look like CI ranges, and any support signal
  ("free tier gone on first call").
- **Decision rule:** revisit only after evidence of pain: a complaint, or
  on-chain paying clients whose `free` count was zero. Until then per-IP is the
  simplest honest meter. Unknown until real CI traffic exists.
- **Effort:** medium (metering code, spoofing tradeoff, migration of counters).

## 5. Volume pricing and prepaid bundles (needs-build)

- **Hypothesis:** a heavy agent (indexer, wallet backend) would rather prepay
  $5 for 500 calls than settle 500 micro-payments; settlement overhead and
  latency, not price, become the objection at volume.
- **Change:** needs-build; not supported by the current per-call x402 flow. A
  prepaid credit keyed to the paying address, or a discount above N settled
  calls per day.
- **Metric:** the trigger is in the ledger: any single client with more than
  ~50 `paid_calls` in a week, or settlements arriving in bursts from one payer.
- **Decision rule:** do not build until at least one client would plausibly use
  it (one payer with 50+ paid calls in a week). Flagged needs-build; zero code
  before the trigger fires.
- **Effort:** large relative to everything else here.

## 6. Marketplace channel: Apify

- **Hypothesis:** Apify Store is zero-marginal distribution to an audience that
  already pays for tools by subscription; it converts users who will never
  touch a crypto wallet.
- **Change:** `apify push` (the actor config exists; see NEXT-STEPS section 3),
  enable Standby, set the $9/mo rental, publish. Marketplace deploys run
  `PAYMENT_MODE=none`, so Apify revenue never touches `/stats`.
- **Metric:** Apify's own dashboard (rentals, runs); keep it separate from
  `revenue_usd`, which stays x402-only. Compare channel revenue monthly.
- **Decision rule:** it costs ~20 minutes once; leave it up unless Apify review
  demands ongoing work. Rental take rate unknown until listed.
- **Effort:** small, one-time.

## 7. Day-14 kill/continue gate

- **Hypothesis:** per the plan in NEXT-STEPS, the wedge is either alive within
  two weeks of launch or it is not; iterating on a channel with zero paying
  strangers is the failure mode to avoid.
- **Change:** none. This is the meta-experiment that bounds all the others.
- **Metric:** on-chain USDC arrivals from strangers (not the test wallet) and
  `settlements` > 0. Target from the plan: +$25 cumulative.
- **Decision rule:** zero stranger paid calls by day 14 after launch posts go
  out -> stop iterating this tool, ship xrpl-intel on the same wrapper and
  rails. Any stranger revenue -> continue, and let experiments 1-3 run.
- **Effort:** zero. Discipline only.

## Sequencing

3 (hint text) now; 6 (Apify) when founder time allows; 1 and 2 only after ~20
organic wall_hits; 4 and 5 only when their triggers fire; 7 always on.
