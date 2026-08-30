# gh-guard — makes publishing under the wrong identity fail closed

**The incident.** On 2026-08-29 two outreach comments were posted publicly under
the founder's personal account instead of `0200project`, on the two most
valuable prospect threads we have. The pre-push hook already checked identity —
but it only fires on `git push`, and `gh issue comment` is not a push.
**The guard existed on the wrong surface.**

## Install (per shell)

```sh
export PATH="$PWD/scripts/gh-guard:$PATH"
```

Put it in your shell rc to make it stick. Verify with `which gh` — it should
show the guard, not `/opt/homebrew/bin/gh`.

## What it does

Allowlists reads and blocks **everything else** when the active account is not
`0200project`. Enumerating writes would miss any subcommand `gh` adds later, and
covering routes nobody has used yet was the requirement — so an unknown command
under a wrong identity is blocked, not waved through.

It fails **closed**: if the active account cannot be determined, writes are
blocked. An unverifiable identity is not permission to publish as the company.

It never blocks `gh auth switch` or `gh auth status`, so it cannot lock you out
of fixing the problem it reports.

Verified in all four directions: wrong identity blocks (exit 1), unreadable
identity blocks (exit 1), `auth switch` is never blocked, correct identity
passes through.

## THE LIMIT — read this before believing the problem is solved

**This is PATH-based, so it only protects a shell that has it on PATH.** Calling
`/opt/homebrew/bin/gh` directly bypasses it. A new session that never sets PATH
has no protection. Like the git hooks, it stops forgetting — it does not stop a
direct invocation.

**The only version that is genuinely impossible rather than merely blocked is
removing the personal account from this machine's keyring:**

```sh
gh auth logout --user <the-personal-account>
```

Then the wrong identity cannot be active because it does not exist here. No
wrapper to bypass, no PATH to forget, no script to skip. **That is a credential
action and belongs to the founder** — it is not something an agent should do to
his accounts. Everything in this directory is strictly weaker than that one
command.
