#!/bin/sh
# Deploy gate. Run before `fly deploy`, or better, via `npm run deploy`.
#
# `fly deploy` builds the WORKING DIRECTORY, not HEAD. A clean `git log` and a
# green local typecheck therefore do not tell you what is about to ship.
#
# The benign version of this bit us on 2026-08-20: a tree carrying another
# session's half-finished edits failed to compile, the build died loudly, and
# nothing shipped. The dangerous version is the one that has not happened yet
# and would be silent -- a tree that COMPILES while carrying uncommitted
# changes ships them with no commit, no review and no audit trail, leaving the
# running artifact matching no commit anyone can inspect. "It compiles" is what
# makes that case dangerous, not what makes it safe.
#
# Several people work in this tree at once. The check is a script rather than a
# habit because a check nobody can forget beats a check everyone agrees to
# remember.

set -e

# Exactly what the Dockerfile copies into the image. Keep in lock-step with it.
# site/ is deliberately absent: it is not in the image, which is the only reason
# earlier deploys from a dirty tree were harmless. That was the Dockerfile
# saving us rather than the process working.
IMAGE_PATHS="src package.json package-lock.json tsconfig.json"

fail() {
  echo ""
  echo "  DEPLOY BLOCKED: $1"
  echo ""
  exit 1
}

echo "predeploy: checking the tree that will actually be built"

DIRTY=$(git status --porcelain -- $IMAGE_PATHS)
if [ -n "$DIRTY" ]; then
  echo ""
  echo "$DIRTY"
  fail "uncommitted changes in files that go into the image.

  These WILL ship, but they are not in any commit, so nothing that ships
  could be reviewed or traced afterwards. If this is someone else's work in
  progress, wait for them to commit rather than committing it for them.
  If it is yours, commit it with explicit paths (not 'git add -A', which
  sweeps up whatever else is on disk)."
fi

echo "predeploy: tree is clean across $IMAGE_PATHS"

# The shutdown window is decided in two places TOML cannot put next to each
# other: `kill_timeout` at top level, and the KILL_TIMEOUT_MS the process reads
# to derive its drain grace. If they drift, we either SIGKILL mid-drain or drain
# far longer than Fly will wait -- and every comment keeps claiming otherwise.
# A comment cannot hold an invariant across two sections; this can.
KT=$(sed -n "s/^kill_timeout *= *'\{0,1\}\([0-9]*\)s\{0,1\}'\{0,1\}.*/\1/p" fly.toml | head -1)
KTMS=$(sed -n "s/^ *KILL_TIMEOUT_MS *= *'\([0-9]*\)'.*/\1/p" fly.toml | head -1)
if [ -z "$KT" ] || [ -z "$KTMS" ]; then
  fail "could not read kill_timeout / KILL_TIMEOUT_MS from fly.toml. Both are
  required: the process derives its shutdown drain grace from KILL_TIMEOUT_MS
  and Fly enforces kill_timeout."
fi
if [ "$((KT * 1000))" -ne "$KTMS" ]; then
  fail "fly.toml disagrees with itself: kill_timeout=${KT}s but KILL_TIMEOUT_MS=${KTMS}.

  The process derives its drain grace from KILL_TIMEOUT_MS. If that is larger
  than what Fly actually waits, a paid request gets SIGKILLed mid-settle -- the
  payer's money moves and they get nothing. Set KILL_TIMEOUT_MS to $((KT * 1000))."
fi
# Matching is not the same invariant as SUFFICIENT. The two values can agree
# perfectly at a nonsense setting -- and a sub-second kill_timeout SIGKILLs a
# settle no matter what we drain, so refuse it rather than making it survivable.
if [ "$KT" -lt 10 ]; then
  fail "kill_timeout=${KT}s is too short to be safe.

  An x402 settle involves an on-chain broadcast and routinely exceeds a few
  seconds. At ${KT}s Fly SIGKILLs the process mid-settle regardless of how we
  drain: the payer's money moves and they receive nothing. Set kill_timeout to
  at least 10s (30s is what production uses) and mirror it in KILL_TIMEOUT_MS."
fi
echo "predeploy: shutdown window agrees (kill_timeout ${KT}s = ${KTMS}ms)"

# The buyer-stuck threshold is the same invariant problem in two FILES rather
# than two TOML sections. The server escalates a waiting buyer to a loud log at
# WAITING_STUCK_AFTER_MS; the pricing page stops telling that same buyer to
# reload and tells them to email us at its own 45000ms mark. They are one
# number. If they drift -- someone retunes the page copy to 30s for a UX reason
# -- our alarm fires at the wrong moment, or worse, the buyer is told to shout
# while nothing on our side has started listening. Neither file's comment can
# hold that; this can.
SRV_MS=$(sed -n 's/^const WAITING_STUCK_AFTER_MS = \([0-9_]*\);.*/\1/p' src/index.ts | tr -d '_' | head -1)
PAGE_MS=$(sed -n 's/.*waitedMs > \([0-9]*\).*/\1/p' site/pricing/index.html | head -1)
if [ -z "$SRV_MS" ] || [ -z "$PAGE_MS" ]; then
  fail "could not read the buyer-stuck threshold from both sides.
  Expected WAITING_STUCK_AFTER_MS in src/index.ts and a 'waitedMs > <ms>'
  comparison in site/pricing/index.html. If either moved, update this check --
  do not delete it."
fi
if [ "$SRV_MS" -ne "$PAGE_MS" ]; then
  fail "buyer-stuck threshold disagrees across files:
  src/index.ts WAITING_STUCK_AFTER_MS=${SRV_MS}ms
  site/pricing/index.html escalates at ${PAGE_MS}ms

  These are one invariant. The page switches the buyer from 'reload' to 'email
  us' at its mark, and the server starts shouting at its own. If the page is
  lower, a buyer is told to email an address while nothing here has flagged
  them. Make them equal."
fi
echo "predeploy: buyer-stuck threshold agrees (${SRV_MS}ms server = ${PAGE_MS}ms page)"

npx tsc --noEmit || fail "typecheck failed"
echo "predeploy: typecheck passed"

npm test --silent > /dev/null 2>&1 || fail "tests failed (run 'npm test' to see them)"
echo "predeploy: tests passed"

# Not a hard gate: this only reaches the running server, which may legitimately
# be behind while a fix is in flight. It is here so a no-op deploy is visible
# rather than silent -- two sessions shipped duplicate no-ops on 2026-08-20 by
# each assuming the other had not.
LIVE=$(curl -s --max-time 10 https://base-tx-explain.fly.dev/healthz 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
LOCAL=$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' package.json | head -1)
[ -n "$LIVE" ] && echo "predeploy: live version $LIVE, local $LOCAL"

echo "predeploy: OK, deploying $(git rev-parse --short HEAD)"
