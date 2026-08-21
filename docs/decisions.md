# Decision record

Durable decisions and why they were made. Each entry names what would reverse it,
so a future session neither treats it as sacred nor overturns it blindly.

Format: what was decided, what the alternative was, what evidence decided it, and
the reversal condition.

---

## D-001 — Not becoming a payments platform ("Stripe for AI agent payments")

**Date:** 2026-08-20
**Status:** Rejected. Revisit only on the conditions below.

### The proposal

Evolve 0200 from one tool into developer-platform infrastructure for autonomous
agent payments: developer accounts, API keys, billing dashboards, usage
analytics, agent wallets, an SDK.

### Why it was rejected

**The position is already occupied, and the parts of Stripe people pay for are
the parts x402 was designed to delete.** Stripe's product is not moving money —
that is commoditized. Stripe sells accounts, keys, dashboards and billing: the
administrative layer. x402 exists specifically to remove that layer. "Stripe for
x402" proposes rebuilding the friction the protocol was created to eliminate.

Adjacent positions are held by better-resourced incumbents: facilitators
(Coinbase CDP, PayAI — free), catalogs (CDP Bazaar, x402scan), agent wallets
(Cloudflare, shipped August 2026).

**Custody is a category change, not a feature.** Routing or holding other
people's funds — even transiently — converts every bug into someone else's loss,
is irreversible on-chain, and likely implicates money transmission. We hold no
keys with spend authority today, and that is currently our single best security
property.

**We cannot currently make the claims a payment platform must make.** Single
machine, no HA, boot gated on a third-party facilitator, financial records in one
unreplicated JSONL file with no tested restore, and zero settlements ever
completed. An SLA cannot be written from data we do not have.

### Evidence that decided it

- Three serious money bugs in one payment feature in four hours, on a rail sold
  only to ourselves. Two would have cost real customers real money. The
  disqualifier was not the bug count — new features have bugs — but that tests
  were green, types were clean, and two reviewers had signed off. Defect
  detection was "someone decided to look," not a process.
- Zero paying strangers. A platform is a harder version of a problem unsolved at
  the easy end.
- No one has asked. Zero requests for billing, accounts or dashboards from any
  party who has engaged with the product.

### What would reverse it

Three or more independent parties, unprompted, asking for account/billing/
multi-tool infrastructure rather than a better decoder. That number is currently
zero. Custody specifically requires, in addition: repeat paying strangers, 100+
real settlements reconciled continuously against the chain with zero divergence,
an adversarial review period finding zero new money bugs, multi-machine HA,
tested restores, and counsel.

---

## D-002 — Not repositioning as a "trust / verification layer for AI agents"

**Date:** 2026-08-20
**Status:** Rejected as positioning. The underlying work continues unchanged.

### The proposal

Reposition as "the transaction intelligence and verification layer that helps AI
agents understand, verify, and safely interact with blockchain." Framed as
Plaid-for-crypto-intelligence and Sentry-for-blockchain-actions.

### Why it was rejected

**It describes a capability the architecture does not have.** `explain_transaction`
takes a transaction hash, and a hash only exists after a transaction is broadcast
and mined. We are forensic, not preventive. "Safely *interact*" implies sitting
in the decision path before an action; we cannot block anything, ever, by
construction. A developer reading "verification layer" and then our own docs —
which correctly state that the absence of a flag is not a safety guarantee —
meets the contradiction inside one page load.

**The preventive position is taken and free.** Simulate-before-sign and drainer
warnings ship free inside Rabby, MetaMask/Blockaid and Wallet Guard, at signing
time, which is a strictly better place than an API because it is in the path and
can refuse.

**"Safely" is the liability word.** A safety false-negative is worse in shape
than any payment bug: uncorrelated to our revenue (we earn $0.02 on the call
where an agent approves a drainer for a fortune), invisible to us (the loss
occurs in someone else's system and no signal returns), adversarially
manufactured (an attacker's job becomes constructing transactions our heuristics
call clean), and it worsens with adoption, because risk scales with trust rather
than volume.

**The analogies mislead about what to build.** Plaid's moat is *access* to data
you cannot otherwise reach; blockchain data is public, so there is no access
moat. Sentry is an installed SDK streaming your own errors to a dashboard you
own; we are a stateless call about someone else's transaction. Building toward
either analogy means building the wrong architecture.

### Evidence that decided it

- **Four sellers already occupy the narrative with no demonstrated buyer**
  (TrustDex, XGuard, strale-io, GPT55). That is not validation, it is a
  supply-side echo chamber: builders pattern-matching to the same pitch.
- **Our most engaged party is not a customer for it.** Circadian verified our
  decode field-by-field against ground truth they already held, and are
  themselves a measurement platform. They are a peer, not a buyer. Treating them
  as demand evidence was a category error, and it was mine.
- **"93% clean decode" is the wrong metric for a safety claim.** It is coverage
  on random traffic; safety is measured on attack traffic, which concentrates in
  precisely the unusual cases making up the other 7%.
- **The flag set is thin.** Measured on 60 live Base transactions: 57% carried at
  least one risk flag, and `unverified_contract` alone fired on 40% of all
  traffic. A warning that fires on four in ten transactions is background, not
  signal. Of the five flags, none requires data only we have, and wallets surface
  the approval warnings natively and free.
- Repositioning is mildly negative on the one channel with measured pull:
  "decode base transaction" is what people search; "verification layer" is not.

### What is genuinely differentiated, and stays

The substantive work is **decode integrity**, not user safety — and they are
different products. Emitter-gated event authentication (a contract cannot forge
an Aave event and have us repeat it), symbol impersonation detection against a
verified label table, and provenance-marking of attacker-controlled strings. That
makes our *output* honest; it does not make the user's *transaction* safe.

### The accurate positioning, adopted

> base-tx-explain turns a Base transaction hash into a plain-English,
> deterministic explanation of what happened — action type, assets moved,
> counterparties, and evidence-based risk flags — so an AI agent can read
> on-chain history without parsing raw logs itself.

Every clause is verifiable by a skeptical developer in ten free playground calls.

### What would reverse it

- Multiple independent parties asking for verification tooling rather than a
  better decoder.
- A measured false-negative rate against a public, reproducible adversarial
  corpus, plus output that can express "this check did not run" (see D-003).
- A deliberate architectural decision to build pre-transaction simulation, which
  is a real product and a real fork, not a copy change.

### Standing constraint

No safety verdict language in any surface: no "safe", no "clear", no green check.
Flags are observations. Absence of a flag is not clearance, and the API and UI
shape must make that impossible to misread.

---

## D-003 — Safety output must distinguish "not checked" from "checked and clean"

**Date:** 2026-08-20
**Status:** Implemented and live (`20855bf`, corrected by `d3b0243`).

When an upstream check cannot run — Sourcify unreachable, blocklist fetch failed
— we emit no flag. In the output that is indistinguishable from having checked
and found nothing. We fail open on a safety signal and do not say so.

This is a prerequisite for any safety-adjacent claim: until the response can
express the difference, the claim is unstateable. Adopted as a standing gate
rather than a nice-to-have.

### What it turned out to be, in practice

Not hypothetical. While auditing, `base.blockscout.com` was returning HTTP 500
(measured 22:04, recovered by 22:20). It is the only source for counterparty
history unless an Etherscan key is configured, so `first_time_counterparty`
could not fire at all during that window, and nothing in the output said so.

The response now carries `checks`, reporting each check as `ok` / `partial` /
`unavailable` / `inconclusive` / `not_applicable`, plus `unchecked_addresses`
and a plain-language note. `summary` gains a sentence when any check is
degraded, because the prose is what an LLM acts on and structured honesty the
consumer never reads changes no decisions.

Two corrections came out of review and are worth keeping visible, because both
were failures of the same kind — reporting better coverage than we had:

- Roll-up inverted: four addresses warranting a check, three checked and all
  three inconclusive, reported `partial`, a *better* status than the identical
  outcome with three addresses. Adding an unchecked address improved the
  reported coverage.
- The scarce lookup slots were allocated in event order, which is chosen by
  whoever wrote the transaction, and `erc20_approval` cannot be emitter-gated.
  Three counterfeit approval events could therefore push a real drain-enabling
  spender out of the checked set. The queue is now ordered by damage potential.

Related: transient upstream failures were cached with the same TTL as real
answers, so a sixteen-minute outage suppressed a check for twenty-four hours
across every caller. Fixed in `2d446d2`. Making the degradation *visible* does
not stop it happening.

### The aggregate half

Per-response honesty tells a caller about their own call. It cannot tell *us*
that a check is broken for everybody: nobody re-reads a served response, so a
check can be dark for hours and leave no trace anywhere we look. A check dark
for N hours is an incident, not a per-response footnote.

So the same statuses are also counted in hourly buckets and reported as
`check_health` on `/healthz` (public, alongside the per-response honesty it
aggregates) and `/stats`, printed by `npm run status`, and named in the daily
report whenever a check was fully dark for an hour or exceeded 5% unavailable
over at least 20 attempts.

Two definitions carry the weight. `not_applicable` is excluded from the
denominator, so padding a day with transactions a check has no work on cannot
dilute an outage into invisibility. And an hour with no traffic neither starts
nor ends an outage — treating silence as recovery would end an incident on the
strength of nobody having called.

It rides the existing ledger as one rollup line per hour (more only while
something is degrading) rather than a monitoring event per call: on a 256MB
machine with a single append-only file replayed into memory at boot, telemetry
that grows with success is telemetry that eventually breaks the boot.
