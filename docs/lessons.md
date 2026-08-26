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

**Corollary — a control has to differ from the suspect in exactly the dimension
being tested.** Two sessions independently near-reported a production outage on
the same day. Both offered a control: other hosts were reachable, so "it is not
my network." Neither control host was on the same platform as the service, so
they established "not my laptop" and nothing more — the suspect dimension was the
platform, and the controls did not vary it. The evidence was equally consistent
with the platform's edge misbehaving, which is what it turned out to be. Before
citing a control, say out loud which single variable it isolates; if it isolates
a different one, it is decoration.

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

## Pushing from a shared branch publishes everything, including someone else's work

_2026-08-21._

A session wrote a vulnerability description into `docs/finance.md` without checking
that the repo is public, and never pushed it — a different session's unrelated
push carried it out on the shared branch. It was public until it was noticed.

This is the deploy lesson below with a different verb. Work leaves this building
by any session's `git push` and any session's `fly deploy`, not only by the one
that wrote it. There is no such thing as "committed but not published here."

**Practice:** before writing anything sensitive into a tracked file, check
`gh repo view --json isPrivate`. Assume anything committed is public the moment
anyone else pushes, which may be minutes and is not up to you. Sensitive detail
belongs somewhere unpushed, with the tracked file carrying a neutral pointer.

**On cleanup:** rewriting public history is usually the wrong reflex. It needs a
force-push, it breaks open PRs and anyone's fetched copy, and it is only worth it
if the leaked thing is still live. If the underlying credential can be ROTATED,
rotate it — that turns the published text into a description of a fixed problem,
and the history stops mattering. Fix the thing, do not chase the paper.

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
   See the private reconciliation notes.

## Green tests that assert a contract the caller never honoured

_2026-08-21, from the false drain alarm on /stats._

For most of a day the reconciler reported `overbooked` and printed "USDC was
swept out of the payout wallet without being declared in
TREASURY_WITHDRAWN_USD". Nothing had been swept. It subtracted every known
non-revenue arrival from the received side and none of it from the booked side,
so the $0.02 favour that was stripped from receipts but left in the books read
as a $0.02 shortfall. **The comparison was measuring its own exclusion.**

Seventeen tests covered this file and seven of them were green across the whole
period. They passed `booked_usd` a customer-only figure. `index.ts` passes
`usage.lifetime.revenue_usd`, the raw ledger total with the favour still in it.
So the tests encoded a contract no caller ever honoured, and every one of them
confirmed the bug instead of catching it — a test suite can only check the
function against the story the test author believed about its inputs.

The generalisable checks, in the order they cost:

1. **When a function takes a number someone else computes, assert on the real
   call site, not on a plausible value.** One `grep` for `reconcile(` would have
   shown `booked_usd: usage.lifetime.revenue_usd` and ended it. Cheaper than
   writing any of the seven tests.
2. **Two figures compared for a difference must exclude the same things.**
   Asymmetric adjustment produces a delta that reports the adjustment. This is
   the seventh appearance of one invariant — revenue is booked only from a
   confirmed, live, settled payment, and every surface showing money must
   distinguish attempted from received and earned from merely arrived.
3. **Grade a control by its failure direction, not its failure rate.** This one
   failed toward alarm, which reads as the safe direction and is not: a drain
   alert that is permanently on is one nobody reads on the day it is right. It
   sat next to a wallet monitor built the same afternoon to detect exactly that
   event. Compare the risk checks, which failed toward silence — opposite
   direction, same defect, which is that the output could not distinguish a
   real answer from no answer.

Found by curling the deployed server and reading the sentence out loud. That is
now twice in two days that a live read caught what a green suite did not, both
times on the endpoint where money is described to strangers.

## Our own activity keeps arriving disguised as a stranger's

_2026-08-21. Six instances in one day, found by five different people._

Every one of these was the same defect: something we did ourselves became
indistinguishable from something a customer did, and the resemblance was only
visible while someone still remembered. Every one of them also pointed the
**flattering** way — toward revenue, demand, or traction we did not have.

| # | What it looked like | What it was | Caught by |
|---|---|---|---|
| 1 | 6 external clients | mostly our own testing | the internal marker, after the fact |
| 2 | revenue on the dashboard | payment *attempts* | growth, before reporting it |
| 3 | our first sale, $0.02 | a favour from a party who declined to buy | the accountant |
| 4 | a stranger paying twice | `scripts/paid-call.ts`, unlabelled | the accountant, by hand |
| 5 | a rejected Stripe delivery | a forged signature I fired to test the alarm | growth, mid-answer to the founder |
| 6 | people hitting the paywall | an outage giving service away free | security, writing the fail-open path |

Instance 6 appeared **twice in one commit**: fixed in the ledger's `wall_hits`,
missed in `since_boot.paywalled`, which is published on the public `/healthz`.
Two people reviewed it before the second copy was found.

### Why it recurs

The two events are genuinely identical on the wire. A test payment IS a payment.
A forged signature rejection IS a rejection. An outage giveaway IS a call with
`charge=true` and no payment attached. Nothing downstream can recover the
difference, because the difference was never in the data — it was in the intent
of whoever ran it, and intent is not persisted.

### The rule

**Label it at the moment it happens, automatically, or accept that it is lost.**

Not "remember to check" — `internal.ts` already made this argument and I
reproduced the bug against the very instrument built on it. The person who knows
is the person who will forget, usually within the hour, and the cost lands on
whoever is asked a question later.

Three properties, all cheap at write time and impossible to add afterwards:

1. **Self-identifying.** Our own traffic carries a marker; we do not reconstruct
   it from timestamps or commit logs. Instance 5 was nearly attributed to the
   wrong agent because their commits matched the minute.
2. **Failing toward suspicion.** A missing label makes our activity look
   external — we investigate ourselves, which is cheap. The reverse dismisses a
   real stranger, which throws away the one signal this project is waiting for.
3. **In its own bucket, not merely excluded.** Excluding degraded calls from
   `free` would have pushed them into `wall_hits`. A category with nowhere to go
   lands somewhere, and it will be somewhere flattering.

### The tell

Ask of any counter that is about to go up: *if I did this myself, five minutes
ago, would this number look different?* If not, the label is missing. Every one
of the six above answers no.

## "Can you show me" beats "did you consider"

Platform reviewed the authorization single-flight and asked three questions. The
one that found a bug did not find it by being asked. I answered Q1 (what is the
key?) correctly from memory — payer and nonce, no cross-payer collision — and
while writing that answer noticed the key ignored `tx_hash`, which meant one
authorization plus N different hashes returned N-1 callers a decode of a
transaction they never asked about. A silently wrong authoritative answer, worse
than the cost bug the module existed to fix.

Q2 (what bounds the map?) went the same way, more starkly. I could answer it from
the source: TTL 10 minutes, cap 1000, evict oldest. The answer was right and the
code was wrong — `prune` ran before the insert, so the map settled at cap+1 and
never held its stated ceiling. **The question did not find that. Writing the test
to answer the question found it**, and it failed on the first run at 1001.

The pattern across today: three defects were caught by review after the author
and a green suite both missed them (`metrics.paywalled`, platform's
`PAYMENT_MODE=none` shim, this). In none of the three did the reviewer already
know the bug. What they did was ask for something that had to be *demonstrated*
rather than *asserted* — and the demonstration is where the gap showed.

So the useful reviewer question is not "did you think about X" — the author
almost always did, and will say so accurately. It is "show me X holding," because
the author has to go build the thing that proves it, and the proof is what fails.

### Corollary: verify the reviewer too

Platform closed a hazard neither of us had raised — our conflict response carries
`isError: true`, the same flag a 402 challenge sets, so could a client mistake a
refusal for a challenge and pay in a loop? They said no, with a mechanism. I
checked it anyway, because a confident peer assertion about library behaviour is
exactly what cost us the `success:false` mistake earlier today.

It holds, and for a stronger reason than the one given: `PaymentRequiredSchema`
is a zod **discriminated union on `x402Version`**, so a payload lacking that key
fails at the discriminator before any field is examined. Not "missing `accepts`
so the parse fails" — it never reaches `accepts`. Same conclusion, firmer floor,
and now written down instead of living in a thread.

## A test that passes for the wrong reason is worse than no test

Four times in one day a green suite confirmed something untrue, each from a
different angle:

1. The reconciler's tests asserted a contract its caller never honoured.
2. Platform's `PAYMENT_MODE=none` shim survived review in a mode nobody ran.
3. The `authOnce` cap was off by one, and only failed when a test was written to
   answer a reviewer's question.
4. Every attribution test called `attribute()` before `settle()`. Production can
   only do the reverse — the webhook arrives, a human promotes minutes later. The
   dimension that mattered was the ORDER, and no test varied it, so 312 passing
   tests confirmed a sequence that cannot occur.

The fourth one carried the sharpest version, and it is platform's sentence:
**a test passing for the wrong reason is worse than a missing test, because it
consumes the suspicion that would have found the bug.** Their `unattribute` test
asserted that money "returns to unattributed" — and passed, because the money had
never left. A gap in coverage is visible to anyone who looks. A test that passes
while asserting the wrong thing actively spends the attention that would have
looked.

### The common shape

Not carelessness. **The author picks the scenario, and the author has already
imagined the world working.** Every one of these four tests encodes the sequence
its writer had in mind, which is the sequence in which the code makes sense. The
order production actually produces was never chosen against, because choosing it
would have required believing it might differ.

### The tell

For any test of a stateful path, ask: *what ORDER do these operations arrive in
outside this file, and does any test use that order?* Setup-then-act is the
author's order. Production has its own, and it is usually the reverse — the event
arrives before the human reacts to it, not after.

### The fifth instance recurred inside the fix for the fourth

Recorded at platform's request, and in their words rather than a kinder
paraphrase. Roughly forty minutes after we agreed this was the most transferable
thing either of us had produced that day, they wrote the test demonstrating the
fix for author-order — **in author-order**, asserting only on the buckets
afterwards and never on what the function returned. It passed while the function
reported success for work it had not done. Their summary: *"I applied the lesson
to the code and not to the test I wrote about the lesson."*

That kills the comfortable reading. Five parallel instances invite "we were tired,
we were rushing". A recursion does not: the pattern survived inside the correction
for itself, held by someone who had just articulated it better than anyone.
Knowing the principle does not appear to help at the moment of writing. The only
thing that reliably caught it today was **a second person executing the thing
rather than reading it** — every one of the five was found by running code, never
by reviewing a diff.

## We made several surfaces under-report on purpose, and that looks exactly like breakage

Platform's sentence, and it is the cost side of everything built tonight:
**under-reporting is indistinguishable from a bug to whoever was not there.**

Nearly every design decision of the night chose the same direction. Revenue is
counted UP from human promotion, so a real sale reads `$0` until someone acts. A
stranded pass is retained and marked rather than deleted, so a paid token answers
`not_activated` instead of working. `never_exercised` is not folded into healthy.
Settlement books no revenue unless confirmed. An outage giveaway gets its own
bucket rather than inflating paywall demand. Every one of those is right, and
every one of them presents, to a stranger at 3am, as the system being broken.

That is a real cost and it was worth paying — a number that under-reports gets
investigated, a number that over-reports becomes a story. But recording only the
benefit would be its own flattering drift. **The mitigation is documentation, and
it is the only mitigation there is**: `docs/try-it.md` now names the failure modes
that are deliberate, in the order someone will hit them, with the handle to fix
each. Without that page the design is indistinguishable from a defect.

### The tell for a statement that outlived its subject

Three instances tonight of a true sentence surviving the change that falsified
it: an init-ordering comment, the justification for deleting stranded passes, and
a boot log reading `(1 active)` for a store holding zero active passes and one
stranded. Platform's sharpening is the useful part, and it is theirs: **all three
were in code they had just changed.**

So the tell is not "audit the comments", which is a job nobody schedules and
nobody finishes. It is a question available in the same breath as the edit:
*did I just change what a nearby sentence describes?* Comments, log lines, field
names and error strings are all statements about behaviour, and an edit that
moves the behaviour leaves them behind silently — no test fails, because none of
them are executed as claims.

### Summaries decay three ways, and only one of them makes a diff

A comment describes the line beneath it, so it decays only when that line
changes — and that change is visible in a diff, next to the comment. A SUMMARY
describes a moving area, and it decays three different ways:

1. **The code changed.** Someone edits the area the summary covers. Visible in a
   diff, but not in one that touches the summary's file — so no reviewer sees
   both halves.
2. **The measurement changed.** A figure written into prose — a call count, a
   client total — is a stale statement with a timer on it. Nothing changed in
   any file; the number simply moved on.
3. **The evidence changed.** The world supplied a new fact and a still-accurate
   sentence stopped being the right conclusion. Our fix ordering was correct for
   a pass-led product and wrong the moment two parties said they wanted per-call.
   No code changed. No measurement was misquoted.

**Only the first produces a diff at all**, and even that one lands somewhere
nobody is looking. For the other two there is nothing to see — not "nothing that
happened to be looked at". So the practice cannot be *review documents more
carefully*: care has no surface to act on. It has to be re-verification against
source, on its own schedule, and the trigger is not *time has passed* but **has
anything underneath this moved — code, measurement, or evidence?**

Five instances in one night across both lists. The two strongest were each of us
auditing our own work after the theory said where to look: a prediction, acted on
independently twice, correct both times. That is the difference between a theory
and a story about a bad night.

The boot-line case is the sharpest because of where it landed: it printed
`1 active` to the one person who most needed to read `1 stranded`, in the exact
scenario the whole retention mechanism exists to serve.

### The corollary: a safe default creates a debt somewhere else

Choosing the safe direction does not remove work, it moves it — out of the failure
path and into the explanation. If you fail safe five times and write nothing down,
you have built something that behaves correctly and reads as broken, and the
person who meets it first will be the one with the least context.

### A watcher only sees the failures its author imagined

I ran an overnight watch on a single-machine service. It checked liveness, the
settlement count and webhook status, and reported "10h, no change." The machine
had restarted at 04:10 — visible the whole time in `booted_at`, which the watcher
never read. It was reachable at every poll, so a restart between polls was
invisible by construction.

Nothing was lost (the restart was an orderly deploy, and the drain worked), but
the instrument would have said exactly the same thing if it had been an OOM kill
that dropped a paid request — the one failure on this box that graceful shutdown
cannot cover, and therefore the one most worth watching for.

**Liveness is not continuity.** "It answers" and "it is the same process that was
answering before" are different questions, and a monitor that only asks the first
cannot distinguish a quiet night from a service that died and came back. The cheap
fix is to watch an identity field — boot time, version, PID — alongside the health
check, because a change there is the event, and a poll that happens to land after
recovery sees nothing.

Same shape as everything else here: I picked the failure modes, and I picked the
ones I had been thinking about that evening.

### A stated plan is testable, and worth testing

The accountant said "I'll be the one promoting a real sale." That is not a
pleasantry, it is an operational claim with a runnable test: settle the shape the
likelier rail actually produces, promote it by the only handle it carries, and
see whether the number moves. It did not. Attribution matched on `id`; both x402
paths emit `tx` and no `id`, so a real sale on the rail with a demonstrated
end-to-end path could be written off but never promoted — and the failure would
have arrived at the exact moment it mattered most, reading as $0 on the night a
first sale was being watched for.

Nobody had written a wrong line of code that day. The gap was between two
correct-looking pieces, and it only appeared when someone asked whether a stated
INTENTION would survive contact with the system. So the rule extends past tests:
when a colleague commits to doing something by hand, run their plan before they
need it. The same afternoon produced two of these, which suggests plans fail this
way about as often as code does — and unlike code, nobody reviews them.

### The sharpest instance: I reproduced a bug I had personally found

The earlier instances are the author violating a principle they had just written.
This one is narrower and worse. Two days after finding "my alarm could be raised
by any stranger with curl" in this codebase — and after catching the same shape
in a teammate's classifier by reading it rather than firing at it — I added a
`console.error` alarm and a public counter to `/paid`, an unauthenticated route
whose only input check is a regex on the shape of a session id. `cs_aaaaaaaa`
passes. Anyone could raise my alarm at will, from outside, for free.

Not an abstract principle misapplied: **the identical concrete defect, on the same
class of endpoint, in the same repo, found by me.** Platform caught it by reading
the input validator, which is exactly what I had done to them.

The useful reading is not that knowing the principle fails to help — that was
already recorded. It is that **having personally found a bug does not
meaningfully protect you from writing it.** Recognition and generation are
different acts, and the memory of catching something lives with the code you were
reading, not the code you are writing. Which is another argument for the only
thing that has actually worked here: someone else running it.

### Visibility is not severity

The same fix carried three defects: a false `promoted: true`, a false log line
claiming a human had attributed a settlement, and a persisted-but-suppressed
attribution that would fire by itself the day anyone edited the list suppressing
it. Platform expected to rank the false `promoted: true` worst, because it is the
one you can see.

The dormant entry was far worse. It fires from an unrelated edit, months after
the click that caused it, and the person who eventually sees revenue move is
looking at a diff that is innocent. A visible wrong answer gets challenged the
first time somebody reads it. A latent one waits, and arrives disguised as
something else — so rank by how the failure ARRIVES, not by how loud it is now.

And when a test passes, check that it would have failed. The cap test, the
ordering tests, and the ERC-1155 truncation test were all written to fail first;
each one did, and each one found something. The tests that were never seen red
are the ones that have never yet been evidence of anything.
