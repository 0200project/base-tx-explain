# Lessons

Things this project learned the expensive way. Short, concrete, and only entries
that would have changed a decision. If an entry stops earning its place, delete it.

---

## An authoritative claim about third-party behaviour is worth exactly the source line it cites

_2026-08-21, from the $9 pass settlement work._

Two near-misses in one evening had the identical shape: a confident, specific,
plausible claim about how a dependency behaves, accepted because of who said it
rather than because it had been read.

1. A reviewing session stated that x402 `settle` returning `success:false` means
   "the transfer did not land, so the customer was not charged," and warned
   against relaxing that gate. It is false. `settlementPendingResponse` returns
   `success:false` **with a real transaction hash** when the receipt wait times
   out *after* broadcast, and `transfer_event_mismatch` means the transfer
   **mined** and only the log check failed. Building on it would have destroyed
   the pass of a customer whose money demonstrably moved.
2. The same fix read the payment nonce from `extra._meta`, reasoning by analogy
   from the MCP SDK. The x402 wrapper does not forward the SDK's `extra`; it
   builds its own `{ toolName, arguments, meta }`. The nonce was always `null`,
   so every paid pass would have been dead on arrival — **100% failure on real
   sales**, with `tsc` silent and every test green.

Neither was caught by review-by-authority. Both were caught in ten minutes by
opening `node_modules` and reading the function.

**Practice:** when a claim about library behaviour is load-bearing for money,
correctness, or safety, cite `file:line` or treat it as unverified — whoever is
making it, including a more expensive model, including the person who wrote the
code. State claims precisely enough to be falsifiable; a wrong claim with a
source pointer is more useful than a hedge, because it can be checked.

**Corollary — prefer guards the compiler enforces.** The `_meta`/`meta` bug is now
a build error, because the handler parameter is typed with the library's exported
`MCPToolContext` instead of `unknown` + a cast. A type that fails the build beats
a comment, a test, and a code review, in that order. Casts on third-party
boundaries are where this class of bug hides.

## On a payment path, ambiguity must fail toward the customer

_Same work._

The fix originally moved passes from "grant, maybe revoke" to "mint inert, activate
on success." That *reads* safer — it protects against the attacker. It is worse.
It flips every ambiguous outcome (`settlement_pending`, a mined-but-mismatched
transfer, a settle that throws and fires no hook at all) from fail-open to
fail-closed, and **the ambiguous cases are exactly where a real paying customer
sits.** Withholding on ambiguity was the same theft in a safer-looking shape.

The asymmetry is not close: losing a $9 exploit is cheap and recoverable; taking
someone's money and withholding what they bought is neither. So: act adversely to
a customer only on evidence that *proves* they were not charged — here, no
transaction hash plus a recognised pre-broadcast rejection. Everything else
grants, alerts, and records why so it can be reconciled later.

**Corollary:** resist adding conditional rules to a path that has already produced
subtle bugs. A lower call cap for unconfirmed passes was proposed and rejected for
this reason — the downside was already bounded and queryable, and the third bug
gets written where the second and fourth rules interact.

## Rank by how much harm is open, not by how interesting the fix is

_2026-08-21, named by the session that made the call._

Two items sat open on the same two files:

- **Splitting a status enum** so "upstream unreachable" and "history truncated"
  stop reporting as the same thing. A return-type change touching cache
  semantics. Intellectually the more satisfying problem.
- **Two TTL arguments**, so a transient failure stops being cached for a day.

The first got picked up first. The second was the one that mattered: a
16-minute Blockscout outage that evening poisoned cache keys for **24 hours**,
silently suppressing a safety check long after the upstream recovered. The
first is a labelling inaccuracy that *under-claims*, and under-claiming harms
nobody. Cheapness and importance pointed the same way and the more interesting
change still won.

**Practice:** rank by (harm currently open) x (how long it stays open), not by
how satisfying the fix is. When two candidates disagree, the boring one is
usually the one with a live victim. A useful tell: if the fix is one argument
and you are still reaching for the other item, check what that other item
actually costs anyone right now.

**The sharper half, and the reason this entry exists.** The same session already
had the outage timestamps in hand — 22:04 failing, 22:20 recovered — and used
them to argue for *alerting*. They were also, unnoticed, a worked example of a
16-minute outage causing 24 hours of degradation. The evidence was already
collected; only the smaller conclusion was drawn from it.

So: when you produce a concrete measurement, ask what **else** it proves before
filing it. Most of the value in a number sits in the second question you ask of
it, and the cost of not asking is that the finding looks like context rather
than a finding.

## Verify a claim when it crosses from internal note to founder-facing assertion

_2026-08-21, refined by the session whose writeup it stopped._

A revenue discrepancy was filed as a tracked task — carefully, with real numbers,
and with an explicit "not asking you to take this." It was ninety seconds from
appearing in front of the founder as a stated conclusion. It was wrong: the money
predated the ledger that would have booked it, and the alarming half rested on
reading a metric that counts payments *attempted* as payments *succeeded*.

What caught it was not diligence in general. "Someone happened to be suspicious"
is not a control — it does not survive a tired night or a busy one.

The transition is the control. A claim moving from internal note to
founder-facing assertion is a **checkable event**, not a mood, and that is the
moment to verify it against a primary source: the ledger, the chain, the library
source. Not the task that asserted it, and not a teammate's summary of it —
those are the thing being checked.

The asymmetry is what makes the trigger the right one. An internal note that is
wrong gets corrected by the next person who looks at it. A founder-facing
assertion that is wrong becomes a decision.

**Practice:** before a claim goes in a writeup, a dashboard, a public metric or a
recommendation, name the primary source you checked it against. If the answer is
"the task that said so," it has not been checked. See also the entry on
third-party claims — same failure, pointed inward.

## The deploy does not build what you committed

_2026-08-21._

`fly deploy` builds the WORKING DIRECTORY, not HEAD. A deploy picked up another
session's half-finished edits; it failed loudly only because that code did not
compile.

The version that has not happened yet is the one to fear: a working tree that
compiles while carrying someone's uncommitted changes ships them silently, with
no commit, no review and no audit trail — and afterwards the running artifact
matches no commit anyone can inspect. Every "I will review the diff before it
ships" agreement in this repo is void against that, because the deploy can ship
something other than the diff.

**Practice:** a clean `git log` and a green local `tsc` are not sufficient
preconditions. Before deploying, confirm the tree is clean for the paths the
image actually contains:

```bash
git status --porcelain -- src package.json tsconfig.json package-lock.json
```

Empty, or do not deploy. (`site/` is not in the image, which is the only reason
two earlier deploys with a dirty `site/` were harmless — that was the Dockerfile
saving us, not the process.)

## Deploying from a shared branch ships everything, not your commit

_2026-08-20._

Two redundant production deploys in one hour, because "my fix isn't live yet" was
assumed rather than checked while several sessions committed to the same `main`.
Restarts are not free once real users hold in-memory state.

Before deploying:

```bash
git merge-base --is-ancestor <your-commit> HEAD && echo "already in HEAD"
```

and read the live boot log to see what production is actually running. Cheaper
than asking a teammate, and it does not depend on anyone having read a message in
time.

---

## A number that adds up is not the same as a number that is explained

_2026-08-20, from the revenue reconciliation work._

The ledger showed 3 paid calls, 0 settlements, $0 revenue; the payout wallet
held $0.02. That arithmetic invites one tidy story — three calls served against
one payment's worth of USDC, so settlement booking must be dropping two of three
— and the obvious next move is to loosen `settledOk`, the gate that decides
whether money is recorded as earned.

The raw events said otherwise. The $0.02 landed 37 minutes *before* the ledger's
first line, on the ephemeral disk that preceded the Fly volume; the three paid
calls moved no money at all, which the chain confirms twice over (no inbound
transfer after that one, and the payer wallet has exactly one outbound transfer
in its life). Two unrelated facts that happened to sum to a plausible third.
Loosening `settledOk` would have booked revenue that does not exist, in a system
whose whole defence against phantom revenue is that gate.

Two things generalise:

1. **The tidy explanation arrived before the evidence and fit it well enough to
   stop the search.** Cost of checking: reading 76 lines of JSONL and one
   `getLogs` scan. Always affordable, and it inverted the conclusion.
2. **A counter that can only under-report is still dangerous if nothing compares
   it to ground truth.** `settledOk` is deliberately strict and the payment path
   deliberately serves on ambiguity, so booked revenue drifting below reality is
   by design and correct. The bug was never the drift — it was that no surface
   subtracted the two numbers, so the drift was indistinguishable from failure.
   See `docs/reconciliation.md`.
