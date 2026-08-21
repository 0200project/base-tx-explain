# Reconciling booked revenue against the chain

The ledger said `paid_calls: 3`, `settlements: 0`, `revenue_usd: 0`. The payout
wallet held $0.02 USDC. Nothing in the product compared those two numbers, so
the disagreement was invisible — and the dashboard is the only view of whether
the funnel converts. If a stranger pays tomorrow and a settlement cannot be
confirmed, the dashboard would read $0 and we would conclude the funnel failed
when it worked.

## What the numbers actually were

Measured 2026-08-20 ~22:30 EDT (2026-08-21 ~02:30 UTC), read directly rather
than inferred.

**On chain** — payout wallet `0xd4ec730a…948a6bc9`, USDC `0x833589fC…bdA02913`
on Base, scanned over every block of the wallet's life:

| | |
|---|---|
| Inbound USDC transfers, lifetime | **1** |
| That transfer | `0.02` USDC at `2026-08-20T17:08:47Z`, tx `0x2a2aaa3a…1e61939f` |
| Sender | `0x2E31f337…5e3D06FC7` |
| Outbound transfers, lifetime | **0** |
| Balance | `0.02` |

The sender's wallet holds `4.98` USDC and has made exactly one outbound transfer
in its life — the one above. That is the throwaway test wallet from
`scripts/paid-call.ts`, funded with $5.

**In the ledger** — `/data/events.jsonl` on the Fly volume, 76 events:

| | |
|---|---|
| First event | `2026-08-20T17:45:29.616Z` |
| `charge:true, paid:true` events | **3** — at `18:12:53Z`, `18:51:46Z`, `18:56:21Z`, all client `3f4d2c03` |
| `settled` events | **0**, ever |

## What that means

Two unrelated facts that happened to add up to a tidy-looking story. It is
**not** three calls served against one payment.

**1. The $0.02 on chain is none of the three paid calls.** It landed at
17:08:47Z — 37 minutes *before* the ledger's first line at 17:45:29Z. The Fly
volume was created around 17:44Z (`lost+found` is stamped 17:44; `fly volumes
list` reports the volume created ~8h before this measurement). Before the volume
existed, `DATA_DIR` was container-local and ephemeral. That call and its
settlement were recorded to a disk that the next deploy destroyed. The payment
settled correctly; only our record of it is gone. It is not recoverable from the
ledger, and the chain is now the only record of it.

**2. The three paid calls moved no money at all.** No inbound transfer exists
after 17:08:47Z, and the payer wallet has made exactly one outbound transfer
ever. All three were verified-but-unsettled: the facilitator verified the
payment payload, the tool executed, the caller got their answer, and settlement
never landed on chain. Booking $0 for them is correct.

So the honest reading of the state is: **one real settled payment we can no
longer see, plus three unsettled calls we correctly declined to book.** The
$0.02 is our own test wallet, not a stranger. Revenue from strangers remains $0.

## Is `settledOk` wrongly rejecting confirmed settlements?

**No.** If `settledOk` were refusing responses for settlements that actually
confirmed, those settlements would have moved USDC, and there would be inbound
transfers matching those three calls. There are none. Settlement genuinely did
not happen. `settledOk` is not the bug and must not be relaxed on this evidence.

One caveat, stated so nobody later mistakes it for a clean bill of health: the
single settlement that *did* confirm happened before the volume existed, so we
have no recorded facilitator response from a successful settle to compare
against. The conclusion rests on the directly observable fact that no funds
moved for the three calls, which is strong — but the first confirmed settlement
after this was written is still worth reading in the logs.

## The check

`src/reconcile.ts` compares booked revenue against the payout wallet's balance,
reusing `src/treasury.ts` (our own Base RPC, three-provider failover, 30s cache)
rather than adding a dependency or a third-party explorer. It is surfaced as:

- `GET /stats` → `reconciliation` (token-gated, same as `treasury`)
- `npm run status` → an `unbooked` / `OVERBOOKED` line, plus a sentence
- the dashboard Revenue section → **Booked revenue**, **Received on chain**,
  and a **Unbooked** tile that turns amber only on a real divergence

`status` values: `reconciled`, `unbooked_revenue` (money arrived we never
booked), `overbooked` (we booked more than the chain holds), `unknown` (the
balance read failed — it says so instead of guessing).

## Limits worth knowing

- **A balance is not a receipts total.** Every dollar swept out of the payout
  wallet looks exactly like a dollar that never arrived, and would show as
  `overbooked`. There are zero outbound transfers today, so balance == receipts.
  The moment that changes, set `TREASURY_WITHDRAWN_USD` to the running total
  swept, and the delta stays honest.
- **The delta is dollars, not calls.** A $9 pass sale and 450 explain calls are
  indistinguishable in it. `unbooked_notional_usd` prices unbooked calls at the
  explain rate only, so it is a floor, not a valuation.
- **It is a report, not a control.** It never rewrites the ledger and never
  books revenue the settlement hooks declined to book.

## What was deliberately not changed

The payment path. `settledOk` still gates revenue strictly, `provablyUnpaid`
still governs pass revocation, and an ambiguous settlement still **serves the
caller**. Failing open toward the payer is the correct tradeoff — denying a real
payer is worse than under-reporting revenue — and under-reporting is recoverable
from the chain precisely because this check now names it. Nothing here moves
money; moving money is the founder's to execute.
