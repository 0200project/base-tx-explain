# Security policy

## Reporting a vulnerability

**Please report privately, not in a public issue:**
[Report a vulnerability](https://github.com/0200project/base-tx-explain/security/advisories/new)

If GitHub advisories are unavailable to you, email **security@0200project.com**.

Include the transaction hash or request that triggered it where relevant — this
service is a deterministic decoder, so a concrete input usually reproduces the
problem exactly.

## What we consider a vulnerability here

This service explains Base transactions to other agents, so **the output being
wrong in a way that misleads is a security issue, not just a bug.** In
particular we want to hear about:

- A decode that asserts something false about what a transaction did — forged or
  spoofed on-chain data that we present as fact.
- A token, contract or counterparty presented as trustworthy when it is not, or
  a risk flag that fails to fire when it should.
- Anything that lets a caller obtain paid output without paying, or that takes a
  payment without delivering.
- Anything that lets one caller affect another caller's results, quota or data.

`risk_flags` fails open by design: a check that could not run produces no flag.
The `checks` field reports whether each check actually ran, so **an empty
`risk_flags` alongside a non-`ok` check status means "not checked", not "clean"**.
That is intended behaviour rather than a vulnerability — but a `checks` field
that reports `ok` for a check that did not really run is very much one.

## Scope

In scope: this service and its API. Out of scope: the Base network itself,
third-party RPC providers, explorers, and the x402 facilitators we call.

## What to expect

We will confirm receipt, tell you honestly whether we can reproduce it, and say
what we intend to do. If we decide not to fix something, we will say so and why
rather than letting it go quiet.
