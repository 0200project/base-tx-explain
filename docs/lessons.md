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
