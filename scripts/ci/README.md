# scripts/ci — a workflow that needs the founder's hands to install

`boundary.yml` is a finished GitHub Actions workflow. It is **not installed**,
because installing it means writing to `.github/workflows/`, and that requires
the `workflow` OAuth scope which our token deliberately does not have. The push
was rejected, which is the gate working rather than a fault.

**To install it (founder, ~30 seconds):**

```
mkdir -p .github/workflows
git mv scripts/ci/boundary.yml .github/workflows/boundary.yml
git commit -m "Install the repo-boundary CI check"
git push
```

**Why it is worth installing.** The pre-push hook prevents internal company
material reaching the public repo, but hooks are advisory and machine-local:
`--no-verify` skips them, and a clone that never runs `npm install` never has
them. That last case — clone, edit a doc, push — is the likeliest accident, not
a contrived one.

This workflow runs on GitHub, so it sees every push regardless of what the
pusher's checkout looked like. It **cannot block a push**; it makes a bypass
loud instead of silent. Prevention and detection, neither sufficient alone.

It checks two things: no internal company docs tracked here, and no credential
patterns outside tests. The credential check greps **patterns only** — a list of
real secret values would itself be the leak, in a more concentrated and more
greppable form than the thing it protects.
