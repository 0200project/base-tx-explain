# .githooks — guards that survive a fresh clone

**Why this directory exists:** these guards used to live in `.git/hooks`, which is
NOT version-controlled. Every protection in them died with a fresh clone, on a
project where several agent sessions share one checkout and new sessions appear
regularly. A guard that exists on exactly one machine is a guard you are one
`git clone` away from losing, without noticing.

`npm install` wires these up automatically (see `postinstall` in package.json).
To do it by hand: `git config core.hooksPath .githooks`

## What they do

- **pre-push** — refuses a push that would publish internal company material
  (`PUBLIC = PRODUCT, PRIVATE = COMPANY`), and refuses a push under the wrong
  GitHub identity. Bypass a founder-approved exception with `PUBLIC_DOCS_OK=1`.
- **commit-msg** — strips AI attribution trailers. Asking produced 93 commits
  carrying one; the hook produced zero. That is the whole argument.

## The limit, stated rather than glossed

**Hooks are advisory and always bypassable** — `--no-verify`, a clone that never
runs `npm install`, `npm ci --ignore-scripts`. They are not a security boundary
against someone who intends to get around them.

They are a boundary against FORGETTING, which is the failure that has actually
happened here, repeatedly. For the cases hooks cannot cover, CI detects after
the fact (`.github/workflows/boundary.yml`) — prevention and detection, neither
sufficient alone.
