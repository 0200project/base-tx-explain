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
| Verified funding located | **$4.98 USDC**, wallet `0x2E31f337…5e3D06FC7` (Base) |
| Unlocated | **$15.02** — see Open Item 1 |

The $20 is an **allocation**, not a verified balance. The only company funds I
can currently see on chain are the $4.98 above. Whether the $20 includes that
wallet, sits somewhere else (card, exchange, unfunded), or is a separate figure
is **unknown and must not be assumed.** Spending is approved against verified
available funds, not against a stated allocation.

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

### Expected non-revenue inbound — pre-logged before arrival

One $0.02 USDC arrival at the payout wallet is **expected** from an external
address (Circadian-agent), an unprompted technical favour to exercise our
least-tested settlement path. Founder approved accepting it.

**It is not a sale, not revenue, and not our first customer. Booked at $0.00.**
There is no commercial exchange: they are not buying transaction analysis, they
are testing our payment rail, and the $0.02 is the instrument of the test rather
than its purpose. Booking it would make our first "sale" a gift from a peer and
every conversion metric derived from it false.

When it lands, two numbers move and must not be misread: payout wallet $0.02 →
$0.04, and on-chain arrivals 1 → 2 "of which 1 external". Any report phrasing
that says "from strangers" must exclude this one. It remains valuable as
**evidence** — the first proof an external party can pay us end to end — and
should be reported as evidence, never as revenue.

## Growth / customer-acquisition expenses

| Date | Agent | Amount | Channel | Purpose | Result |
|---|---|---|---|---|---|
| — | — | $0.00 | — | *no growth spend to date* | — |

**Spent against the $20: $0.00. Remaining allocation: $20.00** (of which only
$4.98 is verified as available — see Open Item 1).

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
| Verified company funds on hand | $4.98 USDC (budget wallet) + $0.02 USDC (payout wallet) = **$5.00** |

Note the $5.00 on hand vs the $20.00 allocated. That gap is the single most
important open question in this document.

## Customer acquisition

| | |
|---|---|
| Spend | $0.00 |
| Visitors | **not measured** — static site, no analytics by design |
| Trials (free-tier users) | 6 unique clients lifetime, but see caveat |
| Checkout starts | 4 payment attempts, all from our own client `3f4d2c03` |
| Paying customers | **0** |
| Revenue attributable | $0.00 |
| **CAC** | **undefined** — not $0. Zero spend and zero customers gives no ratio |

Caveat on "trials": `external_clients` reads 6, but all 6 predate the
internal-call marker and are a historical overcount, not six strangers. New
external clients since the marker shipped: **0**.

Attribution is not known and will not be guessed. If a customer arrives, CAC is
only calculable if Growth can tell me which spend, if any, produced them.

---

## Open items

**1. Where is the $20?** — $20.00 allocated by the Founder; $4.98 verifiable on
chain. Until the Founder confirms the funding form (which wallet, which card,
or whether it is yet funded at all), the approvable ceiling is what I can
verify, not what was stated. *Blocking for any spend above $4.98.*

**2. Who holds COO?** — The spending policy requires Growth → COO + Accountant
sign-off. The `platform` session states plainly that it is not COO and holds no
such authority. No session currently claims the role. Until it is assigned, the
two-key check the policy describes cannot actually be performed. *Needs Founder.*

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
