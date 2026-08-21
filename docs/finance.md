# Finance ledger — 0200project

Owner: Accountant / Controller. Opened 2026-08-21.

**Basis of accounting: cash, on verified settlement only.** A payment is booked
when money has actually arrived and can be seen at its source — a USDC transfer
into the payout wallet on Base, or a settled live-mode charge in Stripe. Nothing
else is revenue. Not a 402 served, not a paywall hit, not a verified payment
payload, not a checkout started, not `paid: true` in the usage ledger (that flag
means a payment payload was *present*, before any verification — it was
misread as revenue twice in one night and has since been renamed
`payment_attempted`).

**Which metrics are revenue:** `settlements` and `revenue_usd`. Nothing else.
`/healthz` also reports `paid_calls` and `payment_attempted` — these are the
same number and **both count attempts**, set when a payment payload is merely
*present*, before any verification. `paid_calls` survives only because a public
status page reads that key from a repo that is behind. **Ignore any field with
"paid" in the name.** Two experienced people misread it as revenue within twelve
hours and one was ninety seconds from reporting a first sale that did not exist.

No accruals, no deferred revenue. The $9 Pass covers 30 days and the $9/month
subscription renews, but at this volume spreading $9 across 30 days would cost
more attention than it is worth. Cash in, cash out, on the day it moves.
Revisit if monthly revenue ever exceeds ~$500.

---

## Cash provided by Founder

| | |
|---|---|
| Allocated | **$20.00** — discretionary customer-acquisition experiment budget, 2026-08-21 |
| Source of that figure | Founder directive, given first-hand to the Accountant |
| **Funded, verified on chain** | **$20.00 USDC**, SPEND wallet `0x2E31f337…5e3D06FC7` (Base), confirmed 2026-08-21 |
| Unlocated | **$0.00 — closed.** |

**Open Item 1 is resolved.** The Founder topped up the SPEND wallet to the
full $20.00 in one transfer (Finance had recommended smaller, deliberate
increments once the balance became the primary control on autonomous spend —
see Open Item 9 — the Founder proceeded with the full amount; noted, not
reversed). Verified independently by Finance by reading the USDC contract's
`balanceOf` for that address directly, twice, not taken from any report:
**$20.000000 exactly.** The approvable ceiling is no longer $4.98 — it is now
the full $20.00, and that full amount is the blast radius until a
balance-bounded spend mechanism is live (see Open Item 9).

## Revenue

All rails, lifetime, as of 2026-08-21:

| Source | Booked | Verified against |
|---|---|---|
| x402 (USDC on Base) | **$0.00** | Inbound USDC at payout wallet `0xd4ec730a…948a6bc9` — 1 arrival lifetime, ours |
| Stripe — $9 Pass (one-time) | **$0.00** | Stripe live-mode settled charges |
| Stripe — $9/mo Developer (recurring) | **$0.00** | Stripe live-mode settled invoices |
| Marketplace — Apify | **$0.00** | Apify payout statement (Apify is merchant of record) |
| Other | **$0.00** | — |
| **Total revenue, lifetime** | **$0.00** | |

Revenue from strangers: **$0.00**. Nothing has been earned yet.

Funnel, for context only — none of it is revenue: 102 lifetime calls · 33
paywall hits · 4 payment attempts (all client `3f4d2c03`, which is us) · 0
settlements.

### Non-revenue money movement

| Date | Amount | From → To | Treatment |
|---|---|---|---|
| 2026-08-20 17:08:47Z | $0.02 USDC | budget wallet `0x2E31f337…` → payout wallet `0xd4ec730a…` | **Internal transfer.** Both wallets are ours. Not revenue, not an expense. Net company cash effect: $0.00. tx `0x2a2aaa3a…1e61939f` |

This is the $0.02 sitting in the payout wallet. It is our own self-test money
moved from one company pocket to another. It has been mistaken for revenue
before; it is not, and it never becomes revenue.

**Mechanism note — transaction count is not a solvency signal on this rail.**
Both wallets show a lifetime transaction count of **zero**, including the wallet
the $0.02 left. Value moves by EIP-3009 `transferWithAuthorization`: the payer
signs an authorization, the facilitator submits the transaction and pays the
gas, so the sending wallet's nonce never increments. A wallet can be fully
drained with its transaction count still reading 0. **Watch the USDC balance and
ERC-20 Transfer events with our address in the `from` position — never the
transaction count.** (Identified by the platform session, 2026-08-21, correcting
an earlier control of mine that would have reported all-clear on an empty wallet.)

### Non-revenue inbound — landed 2026-08-21, high confidence not closed fact

**$0.02 USDC arrived** at the payout wallet 2026-08-21T17:14:49Z, tx
`0x6ce5e3948c9c6b8e0ef8413f3c29623163bb7b58155eda90a67464f3bb119110`, from
`0x9f54460fed51892b3b065eae3ac1603dc3c6ece4` — a new address, not our test
wallet. Payout wallet $0.02 → $0.04. This was pre-logged before it happened:
Circadian-agent, an external x402/MCP research operation, offered twice to run
one real payment through our least-tested settlement path as a technical
favour; the founder approved accepting.

**Treatment: not revenue, not our first customer. Booked at $0.00.** No
commercial exchange occurred — they are not buying transaction analysis, they
are testing our payment rail, and the $0.02 is the instrument of the test, not
its purpose. Added to `KNOWN_FAVOR_TXS` in scripts/daily-report.mjs so it does
not trip the customer-signal line.

**Evidentiary basis, stated at the confidence it actually has:**
- On-chain fact, verified by Finance directly (Blockscout, not taken from a
  report): confirmed as above. This part is certain.
- Attribution to Circadian: **confirmed, closed.** Growth's technical case
  (raw ledger event, the in-band MCP `_meta["x402/payment"]` path exercised by
  real funds for the first time ever, matching client fingerprint) was already
  strong. Finance flagged one gap — the public comment Platform cited could not
  be located (searched coinbase/x402#292 and GitHub-wide, found nothing) — and
  that gap is now closed by a better source: **Circadian confirmed directly**,
  posting their own settlement receipt (same tx hash, same block 50271571, same
  $0.02) matching our record exactly. A counterparty's own receipt outranks a
  comment Finance couldn't find.

**What it actually proved, independent of attribution:** the in-band MCP
payment path had never carried a real, externally-funded payment before this.
It worked. That is true regardless of whose money it was, and it is the more
durable fact — the settlement mechanism has now been exercised by money we do
not control.

## Growth / customer-acquisition expenses

| Date | Agent | Amount | Channel | Purpose | Result |
|---|---|---|---|---|---|
| — | — | $0.00 | — | *no growth spend to date* | — |

**Spent against the $20: $0.00. Remaining allocation: $20.00, fully funded and
verified on chain** (see Open Item 1, resolved).

## Infrastructure & API expenses

| Service | Cost | Status |
|---|---|---|
| Fly.io — 1× 256MB shared machine + 1GB volume, iad | ~$2.00/mo | Estimate, not yet verified against a bill |
| Domain `0200project.com` | unknown | Awaiting confirmation |
| Cloudflare (DNS, Email Routing) | unknown — likely $0 free tier | Awaiting confirmation |
| Proton Mail | unknown | Awaiting confirmation |
| Base RPC (public endpoints) | $0.00 | Public RPCs, no paid tier configured |
| Apify | $0.00 | Merchant of record takes its cut from revenue, not billed to us |
| **Total verified cash spent on infra to date** | **$0.00** | Nothing confirmed billed yet |

Stated infra ceiling: **$25/month**. Current run rate (~$2/mo estimated) is well
inside it. I am not booking estimates as expenses — the ~$2/mo is a run-rate
projection, not money that has left an account.

## Net position

| | |
|---|---|
| Revenue, lifetime | $0.00 |
| Growth expenses | $0.00 |
| Infrastructure expenses (verified cash out) | $0.00 |
| **Net cash flow** | **$0.00** |
| Verified company funds on hand | $4.98 USDC (budget wallet) + $0.04 USDC (payout wallet) = **$5.02** |

Note the $5.00 on hand vs the $20.00 allocated. That gap is the single most
important open question in this document.

## Customer acquisition

| | |
|---|---|
| Spend | $0.00 |
| Visitors | **not measured** — static site, no analytics by design |
| Trials (free-tier users) | 6 unique clients lifetime, but see attribution below |
| x402 payment attempts | 8 lifetime — see attribution below |
| Paying customers | **0** |
| Revenue attributable | $0.00 |
| **CAC** | **undefined** — not $0. Zero spend and zero customers gives no ratio |

**Attribution of the 6 unique clients, as of end of day 2026-08-21 — updated
from the earlier blanket "predates the marker" caveat now that individual
clients have actually been identified (see D-5):**

| Client | Identity | Paid attempts | Settled |
|---|---|---|---|
| `3f4d2c03` | Us — established since day one | 4 | 0 |
| `53d7ceaf` | Us — `paid-call.ts` gap, fixed `ded8d41` | 2 | 0 |
| `8f92f999` | Circadian — matched to settlement second by growth | 2 | 1, booked $0.00 (favor) |
| `56cb6309` | Unexplained, organic, 3 calls, never returned | 0 | — |
| `c63f048f` | Unexplained, organic, 1 call, never returned | 0 | — |
| `1b624776` | Unexplained, organic, 1 call, never returned | 0 | — |

**The honest read: three genuinely unattributed one-off visitor touches
today, zero repeat visits, zero payment attempts from any of them, zero
customers.** Nothing here is being called a lead — one or two free calls with
no return is not evidence of anything beyond a visitor who looked once.

Attribution is not known and will not be guessed. If a customer arrives, CAC is
only calculable if Growth can tell me which spend, if any, produced them.

---

## Open items

**1. Where is the $20?** — $20.00 allocated by the Founder; $4.98 verifiable on
chain. Until the Founder confirms the funding form (which wallet, which card,
or whether it is yet funded at all), the approvable ceiling is what I can
verify, not what was stated. *Blocking for any spend above $4.98.*

**2. ~~Who holds COO?~~ RESOLVED 2026-08-21, directly by the Founder.** No
session is assigned the COO title, and the Founder has said not to hold
approvals on that — `platform` fills the senior-review function the spending
policy assigns to COO, on the standing of an experienced team member, title
notwithstanding. The two-key check for a Growth spend is now Growth → platform
+ Accountant.

**3. Stripe settlement visibility.** — Card checkout went live tonight. I have
no read access to Stripe, so I cannot independently verify a settled charge at
its source. Our own ledger writes a `settled` row only on `livemode === true`,
which I trust as far as the webhook is trustworthy — see Open Item 6. Until I
have a second source I will book Stripe revenue from the ledger and treat it as
unreconciled. *Needs either Stripe read access or a reliable relay.*

**6. Card-rail books-integrity item — tracked privately.** A credential-handling
issue affecting the integrity of Stripe-side revenue booking was identified
2026-08-21 and is being handled with the security session and the Founder.
Details are deliberately **not** recorded in this file: this repository is
public, and a written description of an unresolved control weakness is an
advertisement. Recorded here only so the ledger shows the item exists and is
owned. Remove this note once resolved.

Finance's position while it is open: Stripe-side `settled` rows are booked but
treated as **unreconciled** until verified against Stripe itself.

## Flagged discrepancies — open

**D-1. `/stats` reconciliation reports `unbooked_revenue` that does not exist.**
Raised 2026-08-21 by Finance. `src/reconcile.ts` compares wallet balance against
booked revenue and labels any positive delta as unbooked revenue. Today it
returns `status: unbooked_revenue`, `delta_usd: 0.02`, and a note reading "Real
money, unrecorded." Every figure is arithmetically correct and the conclusion is
wrong: that $0.02 is our own internal transfer, and it predates the ledger. The
reconciler has no concept of a *known non-revenue inbound*, so it cannot read
`reconciled` while our own test money sits in the wallet — and the only way it
clears is if someone wrongly books $0.02.

Escalates when the Circadian favour lands: delta becomes $0.04 from a genuinely
external address, removing the one clue a careful reader has today.

Fix specified to the platform session — subtract a known-non-revenue baseline
(by tx hash) so the comparison is *received from customers* vs *booked*; keep the
raw received figure, just stop labelling it revenue. Same three-bucket shape the
daily report adopted. Also flagged: `unbooked_paid_calls: 4` /
`unbooked_notional_usd: 0.08` sit adjacent to the delta and read as its
explanation. They are unrelated — those 4 attempts moved no money, and the $0.02
predates them. Notional, not owed, not received.

**D-2. A failed read was recorded as a clean $0.** The 2026-08-21 daily report
ran during a window when `/stats` was unreachable and published usage as
unreadable while the revenue section still rendered. No money impact — revenue
was and is $0.00 — but the principle stands: **unknown must never render as
zero.** A zero you verified and a zero you could not read are different facts,
and only one of them is evidence. Numbers were re-read after recovery and are
recorded above.

*Cause, corrected:* Finance first attributed this to a production restart
window. That was wrong. `booted_at` reads 2026-08-21T16:50:15.584Z and was
identical before and after the incident, so the process never restarted — there
was no restart window to blame. The failures clustered on Fly-hosted
destinations (our app *and* Fly's own `api.machines.dev`) while non-Fly hosts
answered normally, which points at the network path or Fly's edge, not our
application. (Corrected by the security session.)

*Method note worth keeping:* the controls Finance used to rule out a local
network fault — `api.github.com` and `0200project.com` — are GitHub and GitHub
Pages. Neither is on Fly. So they established "not our laptop" but could not
distinguish "our server" from "the path to Fly", and the conclusion drawn from
them overreached. **A control host has to differ from the suspect host in
exactly the dimension being tested.**

*Watch item if it recurs:* the request path does synchronous disk I/O per call
on one shared vCPU (ledger `appendFileSync`, whole-file pass-store rewrite,
free-tier flush). Under concurrency that blocks the event loop and looks exactly
like connection failures with no crash and no restart — in which case a constant
`booted_at` is the confirming signal, not a reassuring one.

**D-3. The public `/healthz` endpoint now shows revenue a stranger would
misread as a paying customer.** Raised 2026-08-21 by security. `revenue_usd`
on `/healthz` — public, no auth — reads **$0.02**, because the Circadian favor
settled through the normal payment code path and the code cannot distinguish a
pre-arranged favor from a commercial sale at settlement time; only Finance's
out-of-band knowledge can. These books correctly show **$0.00**. The
divergence is intentional and explained internally (see the Non-revenue
inbound entry above), but `/healthz` is a public surface, and anyone reading
it — a stranger, a writeup, a would-be customer sizing us up — sees $0.02 with
none of that context. That is the exact shape of the invariant security wrote
into `docs/security.md` ("every surface that displays money must distinguish
attempted from received"), except this is settled-but-not-a-sale rather than
attempted-but-not-settled — a case the invariant did not anticipate. The
reconciler and the daily report already apply a known-non-revenue exclusion
(`KNOWN_FAVOR_TXS` / `known_non_revenue_usd`) to keep this exact confusion out
of internal numbers; the public `revenue_usd` field does not. Flagged to
platform, who owns the endpoint; implementation is theirs to choose — apply
the same exclusion, or label the field so it can't be read as vetted
commercial revenue. Not urgent (traffic is negligible today), but it should
not sit indefinitely on a field anyone can curl.

**7. Autonomous agent spend — CONFIRMED 2026-08-21, directly by the Founder,
scope now explicit.** First relayed secondhand via the platform session, then
confirmed directly to Finance twice: autonomous/automatic spend is approved.
The second confirmation named the scope explicitly, which the first did not:
**full autonomous spend on the SPEND wallet only** — the budget wallet
`0x2E31f337…5e3D06FC7`. The **RECEIVE wallet** — payout, `0xd4ec730a…948a6bc9`
— is not in scope and stays receive-only, as it already is by design (the
server holds no key that can move funds from it; see the reconciliation notes
above). No spend authorization of any kind applies to the RECEIVE wallet.

The Founder also asked, in the same message, that Finance coordinate with
security to prevent compromise of either wallet "completely." Finance's
position, stated plainly rather than promised: **no system is completely
unhackable, and Finance will not represent it as such.** What is achievable
and has been asked of security: the RECEIVE wallet is already about as close
to that as engineering gets, by construction — no automated path exists to
move funds out of it. The SPEND wallet is a different problem the moment
autonomous spend is live: authorizing an agent to spend is authorizing a
signing mechanism, and any signing mechanism is a target. The realistic goal
there is bounding the blast radius, not eliminating risk — see the mitigations
below, now handed to security to own.

What is independently verified, and is the reason this item is not urgent: no
private key exists anywhere in this system today (platform's audit of `src/`),
so no agent — including Growth — currently has the technical means to spend
anything. This is a forward-looking policy question, not a live capability.

Finance's position if and when it becomes live: the hard rules and the $20
ceiling in this ledger apply regardless of who or what initiates a spend.
"Autonomous" should mean bounded by wallet balance, not by a written limit
that software can be wrong about — fund only what is acceptable to lose
outright, in a wallet separate from the payout wallet, scoped so a signer can
only pay x402 challenges to our own endpoint. This product reads
attacker-controlled strings off a public blockchain (a live token named "BUY
FLASH USDT" with instruction-like text prompted the provenance-marking work);
an agent that can both read attacker-authored text and spend money is a
prompt-injection target with a payout attached. Every such spend, autonomous or
not, gets logged the same way as any other expense in this ledger — no
exception for "automatic."

**9. What is autonomous spend actually FOR? — ANSWERED 2026-08-21, directly by
the Founder.** Both: **our own endpoint, and — more importantly — spend that
gets us clients.** That means third-party spend is explicitly in scope, not
just dogfooding. **Destination cannot be pinned.** Per security's own framing
of the two builds, this is the harder one: the design leans entirely on amount
limits and balance rather than a pinned destination making a compromised agent
a no-op. Relayed to security and platform to unblock the spec.

Security's framing of the risk, worth recording verbatim rather than
paraphrasing: **"the most you can lose from the SPEND wallet is a number you
choose."** Balance is the control that cannot be reasoned around, because no
compromise spends money that isn't there. Zero ETH in that wallet is *not* a
control — EIP-3009 lets a third party submit and pay gas on the holder's
behalf, so an attacker with the key can still move the full balance.

**That number is now $20.00, not $4.98.** Security recommended topping up in
small, deliberate increments once balance became the security boundary. The
Founder funded the full $20.00 in one transfer before that recommendation
reached him. Recorded plainly, not reversed: **the full allocated budget is
now the blast radius from the moment a signer is wired, not before** —
security confirmed no spending key exists anywhere on the server or in any
agent's reach today (audited directly: only `STATS_TOKEN`, the two CDP keys,
`STRIPE_WEBHOOK_SECRET`, `INTERNAL_MARKER`; `X402_TEST_PRIVATE_KEY` appears
only in `scripts/paid-call.ts` and is unset). **Controls before capability**:
no spending key gets wired into anything agent-reachable until the caps below
exist. The $20 is not at risk today; it becomes the risk the day a signer
ships, so that is the sequencing to hold the line on, not a drawdown of funds
that are currently safe.

The sharpest finding, recorded here because it is a hard boundary Finance
should hold the team to regardless of implementation: **if a spending agent
ever consumes this product's own `explain_transaction` output as a decision
input, an attacker who crafts a transaction can write text directly into the
spender's context — a closed loop from attacker-controlled chain data to our
own money.** Must never be wired that way.

**Finance's detection posture, set 2026-08-21 per security's design.** Because
the payee is agent-chosen and agent inputs are attacker-reachable, a
manipulated agent paying an attacker's own x402 endpoint is indistinguishable
from a legitimate payment at every technical level — well-formed transaction,
valid signature, plausible service, correct amount. **There is no anomaly to
spot, so detection cannot be anomaly-based.** It has to be reconciliation:
**every outflow from the SPEND wallet gets matched against a pre-justified,
already-logged expense in this ledger; anything unmatched is the alert.** This
ledger is the control, not a record kept after the fact — the four-line
proposal format (Amount / Purpose / Channel / Expected outcome) that already
exists for Growth spend is what "pre-justified" means in practice, and it now
does double duty as a security control, not just a bookkeeping courtesy.
Caps, sized to the current $20 balance: **roughly $1/transaction, $5/day** —
keeps a fully-compromised agent's daily damage small without blocking real
use. Same spec handed to platform.

**Two requirements on that format, tightened 2026-08-21, before it's asked to
carry security weight it wasn't built for:**

1. **The proposal must exist before the spend, enforced by ordering, not
   convention.** Reconciliation only works one direction — an outflow matched
   to a *prior* justification. A proposal written after the money moved makes
   an attacker's payment indistinguishable from a legitimate one documented
   late, and the control quietly becomes a formality. Timestamps in this
   ledger must be checked, not assumed.
2. **It must name amount, payee, and purpose — payee specified before the
   money moves, not "Growth spend, $5."** A vague proposal matches any
   outflow of that size; a named payee is the one field an attacker cannot
   satisfy after the fact, because they can induce a payment but cannot make
   it match a payee written down in advance.

**Requirement 2, followed to its conclusion, is the allowlist — arrived at
from the accounting side rather than as a signer constraint.** If every spend
must name its payee in advance to reconcile, that is a per-transaction human
approval already, just expressed as bookkeeping. The two options in Open
Item 9 below are therefore closer than they look: **the allowlist blocks a bad
payment before it happens; this ledger's reconciliation catches it within a
day of it happening.** Same information, earlier or later. The difference is
whether $20 is prevented or discovered gone.

**Open product question, explicitly not decided by security or Finance —
needs the Founder.** "Anything endpoint" as a product goal does not require
"anything endpoint" as a signing permission. An alternative: the agent
discovers and *proposes* a payee, a human approves it once, and payment to
that payee is automatic thereafter. This converts the worst-case attack — pay
the attacker — from an undetectable success into a blocked transaction,
materially stronger than amount caps alone. If declined, caps, balance, and
this ledger's reconciliation still work — they just carry the whole defense,
with same-day rather than pre-transaction detection, instead of backstopping
a signer-level block.

**8. Funding form of the $20 — RESOLVED 2026-08-21, directly by the Founder
(relayed via platform).** USDC to the budget wallet — already executed, see
Open Item 1. In the same message the Founder drew a channel split that
changes what "$20 budget" refers to going forward:

**AUTONOMOUS = x402 only.** The $20 USDC in the SPEND wallet
(`0x2E31f337…5e3D06FC7`) is the *only* pot anything can spend from without the
Founder acting himself. Agent-initiated, no per-transaction approval once the
caps from Open Item 9 are live, bounded by the wallet's balance.

**NOT AUTONOMOUS = card.** Ads, tools, SaaS — anything with a card form. An
agent proposes, the Founder approves, and **the Founder's own hands enter the
card details, always.** No agent holds, sees, or types a card number — this
matches Finance's own standing operating rule (entering payment credentials is
prohibited, full stop, no exception for founder authorization) and now applies
to every agent on the team, not just this one. The two-key spend check (Amount
/ Purpose / Channel / Expected outcome, checked against availability and
budget) still applies to the *proposal*; execution never does.

**Consequence for what Finance can actually see:** card spend has no wallet,
no ceiling Finance knows of, and **no balance any monitor can read.** It is
whatever the Founder approves, on whatever card, and Finance learns of it only
when told — by the Founder or the proposing agent. This is a structural blind
spot, not a gap to be fixed: the reconciliation posture from Open Item 9
(every outflow matched to a pre-justified, named-payee proposal) applies to
card spend *more* than x402, precisely because a card charge leaves no on-chain
trace Finance can independently verify — this ledger becomes the *only* record
that a card charge was ever justified, not a cross-check on one.

**Recorded, not yet mine to decide:** platform proposed, and Finance agrees on
principle, that an agent's involvement in any card purchase should end at the
payment form — make the case, name the cost, link the page, then stop. This
already binds Finance directly under its own operating rules; recording it here
so it is written down as team policy rather than resting on each agent holding
the line individually.

**On the open allowlist-vs-caps question (Open Item 9, above): likely
narrowed, possibly moot.** If "spend that gets us clients" resolves mostly to
card — which needs no wallet, no key, no signer — then x402 autonomous spend
may be dogfooding-only, in which case `to` gets pinned to our own `payTo`, a
fully compromised agent can do nothing but pay us, and there is nothing left
to allowlist. Security put the sharper question to the Founder directly: is
there any third-party x402 service we would actually pay?

**The Founder turned that question back to the team rather than answering it
himself** — reasonable: Finance doesn't have ecosystem knowledge of what x402
services exist and are worth paying for; that's Growth's and platform's
territory, not the books'. Routed to them. Answer pending.

**Card spend budget — ANSWERED 2026-08-21, directly by the Founder: need and
ROI basis, not a fixed cap.** No pre-set dollar ceiling on card spend the way
the $20 USDC is a hard ceiling on x402. Each proposal is judged on whether the
need is real and the expected return justifies the cost — which puts more
weight on the "Expected outcome" field of the four-line proposal format than
it previously carried, since there is no balance to fall back on as a backstop
the way there is on the x402 side. Finance's check on a card proposal is
therefore: is the need and expected return actually stated and plausible, not
"is it under some fixed number" — there isn't one.

**D-4. The reconciler flipped to a permanent false `overbooked` alarm — the
opposite failure of D-1, same root cause.** Raised 2026-08-21 by platform, who
found and fixed it before Finance saw it. When the known-non-revenue exclusion
(built to fix D-1) shipped, it was applied to the *received* side of the
reconciliation ($0.04 → correctly excluding the Circadian $0.02) but not to the
*booked* side, which still held the $0.02 as booked. Both sides must exclude
the same known-non-revenue amount or the comparison measures the exclusion
itself rather than the money — asymmetric subtraction manufactured a $0.02
"shortfall" where none existed. `/stats` had read `status: overbooked` with a
note claiming USDC was swept out of the payout wallet undeclared, continuously,
since the Circadian probe settled. **Nothing was swept; Finance's own
independent chain read throughout this period showed the correct $0.04.**

Why this one is worse than D-1 through D-3: it failed in the direction that
**disables a control rather than merely misinforming.** The wallet monitor
built this afternoon exists specifically to catch an unexplained payout
decrease. A standing false alarm on a neighbouring surface is exactly the
condition under which a real one gets ignored — "it's probably that bug
again." Detection depends on quiet-when-fine being reliable.

Verified independently by Finance after the fix, not taken from platform's
report: `/stats` now reads `status: reconciled`, `delta_usd: 0`,
`booked_from_customers_usd: 0`, `received_from_customers_usd: 0`. The public
`/healthz` also now carries `revenue_from_customers_usd: 0` with an explicit
note — confirms D-3 is closed on the actual public surface, not just `/stats`.

Also notable on how it was found: the reconciler's own test suite was green
throughout, because the tests asserted a contract the production caller never
honored (fed the reconciler a customer-only figure; `index.ts` feeds it the
raw ledger total). Found by reading the deployed server's actual output, not
by trusting a passing test suite — the same discipline this ledger has needed
all day.

**D-5. RESOLVED 2026-08-21, within minutes, by platform. `53d7ceaf` is us.**
Investigated by Finance first rather than left unexamined, then confirmed by
platform with decisive proof: the client tag is `sha256("btx:"+ip).slice(0,8)`
— IP-derived only — and that same tag made an earlier call at 16:18:22Z
carrying `internal: true`, meaning it presented the `INTERNAL_MARKER` secret,
which lives only in our own environment. A stranger cannot share an IP with a
request bearing our internal secret. Root cause: `scripts/paid-call.ts` — the
script whose entire job is to look like a genuine x402 buyer — never sent the
marker header, so its own realism made it the one hole. Fixed in `ded8d41`:
sends the marker when set, warns loudly at startup when unset, and the failure
direction stays deliberately safe (unset still reads as unmarked, so an actual
stranger is never miscounted as us). One correction to Finance's own note
above: the timing coincidence with the 17:25:41Z restart was just that — a
coincidence, not the mechanism; the machine actually booted later, at
17:52:24Z. Refusing to attribute it without a real check was still the right
call — it took four minutes and converted an open question into a fixed bug
rather than a guess either way.

**Consequence for the "6 external clients" figure:** at least **3 of the 6**
are now individually identified and explained — `3f4d2c03` (us, predates the
marker), `53d7ceaf` (us, the paid-call.ts gap, now fixed), and `8f92f999`
(Circadian — independently matched by growth to the settlement second, not
a customer). The remaining **`56cb6309`, `c63f048f`, `1b624776`** each made
one to three calls and never returned — genuinely unexplained, organic, and
not converted. That is the honest count of real, unattributed visitor
interest today: **three one-off touches, zero repeat, zero paid.**

## Known corrections to the record

- **Phantom $9 Stripe settlement, removed 2026-08-21** (by the platform
  session, before Finance existed). A test-mode purchase booked as real revenue
  because the webhook was not checking Stripe's `livemode` flag. Webhook fixed,
  row deleted, ledger backed up to `/data/events.jsonl.bak-before-phantom-removal`.
  This explains a 102 → 101 line discrepancy in the event ledger. Correct call:
  test-mode money is not revenue.

- **The lost settlement, 2026-08-20.** One real x402 payment settled ~37 minutes
  before the persistent volume existed; its ledger row was written to ephemeral
  container disk and destroyed on the next deploy. The chain is now its only
  record. It is our own test money, so it does not affect revenue — but it is
  the reason the ledger and the chain disagree by one event. Not recoverable.
  See `docs/reconciliation.md`.

## Service delivered without confirmed payment — a known, enumerable category

On the x402 rail, when settlement returns ambiguous (`settlement_pending` with a
real tx hash, or mined-but-mismatched), the customer's pass is **activated**
rather than withheld, because those states can mean the money moved and
withholding would rob a payer. This is deliberate and Finance agrees with it:
refusing to deliver to someone whose money probably moved is the worse error.

These are recorded on the pass entry with the reason and enumerable via
`listUnconfirmed()` in `src/passes.ts`. Standing line item — it is a known
category, not a leak, and it is exactly the thing that would otherwise surface
later as an unexplained gap between service delivered and revenue booked.
Current count: to be read at each daily close. Lifetime `pass_calls`: 1.

## Reconciliation notes

- **x402 and Stripe will never reconcile against each other.** x402 settles
  USDC to a wallet on Base; Stripe settles fiat to a bank. Any check comparing
  the payout wallet against total revenue will look broken while being correct.
  The payout wallet is the source of truth for x402 **only**.
- **Apify revenue arrives net.** Apify is merchant of record at $20/1,000 calls.
  What lands is a payout after Apify's cut, on Apify's schedule — so booked
  marketplace revenue will not equal $0.02 × calls, and should be taken from the
  payout statement, never computed from call counts.
- **Payout wallet: any balance decrease is an incident, full stop.** The wallet
  is receive-only by construction — the server holds no key that can move funds,
  and the x402 exact scheme pins the destination in the signed authorization, so
  a replayed payment can only push the payer's own funds *to* us. The Stripe side
  holds no API key either, only a webhook signing secret, which can verify
  signatures but cannot refund, charge, or read a customer. **There is no
  automated path in this system that could reduce that balance.** So a decrease
  has no benign technical explanation and is an incident immediately, not a bug
  to investigate first. (Design confirmed by the security session.) Watch the
  balance, not the transaction count — see the mechanism note above.
- **Budget wallet: a decrease is expected but must match a logged expense.**
  Spending is its purpose. The alert condition is not "it fell" but "it fell and
  Finance has no matching row."
- **A failed read must report as unknown, never as no-change.** If a balance
  check cannot reach an RPC, silence must not be recorded as a clean result —
  same principle as the `check_health` dark-hours work.

## Price of record

Free $0 (10 calls/client) · x402 $0.02/call · 0200 Pass $9 one-time (30 days,
10,000 calls) · 0200 Developer $9/month recurring · Apify $20/1,000 calls.

---

## Daily close — 2026-08-21

Verified at source (wallet balances via RPC, `/stats` re-read after the earlier
failed read). Not inherited from any report that could not complete.

| | |
|---|---|
| Revenue — x402 | $0.00 |
| Revenue — Stripe (Pass + Developer) | $0.00 |
| Revenue — marketplace (Apify) | $0.00 |
| **Total revenue** | **$0.00** |
| Growth spend | $0.00 |
| Infrastructure cash out | $0.00 |
| **Net cash flow** | **$0.00** |
| Funds on hand | **$20.04** ($20.00 budget, fully funded 2026-08-21 + $0.04 payout) — cross-verified against platform's live wallet monitor at `/wallets` (stats-token gated, not public), first read 17:52:48Z, exact match |
| Growth budget | $20.00 allocated · $0.00 spent · **$20.00 verified available** |

Usage context, not revenue: 126 lifetime calls · 43 paywall hits · 8 payment
attempts · **1 settlement, $0.02** · 1 pass call, re-read from `/stats` at end
of day. That one settlement is the Circadian favor (see above) — booked $0.00
in these books despite the underlying ledger's own `revenue_usd` field showing
$0.02, because the code that books a settlement cannot distinguish a
pre-arranged favor from a sale; only Finance's out-of-band knowledge can, and
this is exactly the D-1 divergence, now with a real number attached instead of
a hypothetical one. **Total revenue in this ledger remains $0.00.** Zero
payment attempts, of eight, were from a party paying for the product.

The settlement path itself is verified end-to-end for the first time and
survived a machine restart at 17:25:41Z the same evening — settled on chain,
confirmed by the webhook, written to the ledger, persisted through a restart.
A systems result, not a revenue one, and independently confirmed by both the
platform and security sessions reading the chain directly rather than a
report. Security also independently reconfirmed the balance-monitor correction
already recorded above: the payout wallet's nonce is 0 while it holds USDC, so
transaction-count monitoring is blind on this rail — watch balance and
Transfer events where the wallet is `from`.

**CAC: undefined.** Zero spend and zero customers is not a $0 CAC — it is no
ratio at all.

**What today actually established:** nothing was earned and nothing was spent,
so the financial position is unchanged from opening. The day's work was making
the position *knowable* — opening this ledger, correcting the $0.02 from
"revenue from a self-test" to an internal transfer with zero net effect,
pre-logging an expected non-revenue inbound before it arrived, and flagging an
automated reconciler that asserts revenue we do not have.

**Blocking Finance, remaining, both needing the Founder:** the funding form of
the $20 is unconfirmed, capping approvals at $4.98; and the Stripe signing
secret rotation is his to execute. (The COO question is resolved — see Open
Item 2 — and autonomous spend is now confirmed policy — see Open Item 7.)
Nothing has blocked the team yet — no spend above $4.98 has been
requested.

---

## Standing rule, now enforced by the codebase itself

The security session has written Finance's core rule directly into
`docs/security.md` (85bc761) as a re-review trigger for every new payment rail:

> REVENUE IS BOOKED ONLY FROM A CONFIRMED, LIVE, SETTLED PAYMENT, AND EVERY
> SURFACE THAT DISPLAYS MONEY MUST DISTINGUISH ATTEMPTED FROM RECEIVED.

Three violations on three separate rails inside twelve hours — the x402
unconfirmed-settle booking, `paid_calls` counting attempts beside
`revenue_usd` on a public endpoint, and the test-mode $9 phantom row —
each arrived as a fresh bug, not a regression of a fixed one, because each
new rail arrived without the rule attached. It is now checked against
every new rail rather than rediscovered per-rail. Finance is told
whenever the definition of a verified settlement changes on either rail —
standing commitment from the security session.

**The one deliberate exception, not a bug:** a pass is activated on
ambiguous x402 settlement — service delivered without confirmed payment,
on purpose, because withholding from someone whose money probably moved
is the worse error. This must never be "fixed" by someone tidying up
service delivery; it is tracked as its own known category above, not
mixed into the revenue definition.
