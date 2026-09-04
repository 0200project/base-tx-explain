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
# The free-tier size is ALSO decided in two places: fly.toml's FREE_CALLS_PER_IP
# and the code default in src/freeTier.ts that applies when the var is unset.
# They drifted -- the default stayed at the retired 10 after the tier moved to
# 50 -- and nothing caught it, because the retired-facts check reads tracked
# FILES for stale prose and a code default is neither prose nor wrong-looking.
#
# It matters now that it is not just ours: a self-hoster runs with no env at
# all, meets the default, and reads 50 on our site. Same class as kill_timeout,
# so it gets the same treatment rather than a third one-off fix.
FC_TOML=$(sed -n "s/^ *FREE_CALLS_PER_IP *= *'\([0-9]*\)'.*/\1/p" fly.toml | head -1)
FC_CODE=$(sed -n "s/.*FREE_CALLS_PER_IP ?? '\([0-9]*\)'.*/\1/p" src/freeTier.ts | head -1)
if [ -z "$FC_TOML" ] || [ -z "$FC_CODE" ]; then
  fail "could not read FREE_CALLS_PER_IP from fly.toml and src/freeTier.ts.
  Both are required: the env var is what production serves, the code default is
  what everyone else serves."
fi
if [ "$FC_TOML" -ne "$FC_CODE" ]; then
  fail "the free tier disagrees with itself: fly.toml says $FC_TOML, the code
  default in src/freeTier.ts says $FC_CODE.

  Production serves $FC_TOML. Anyone running this without the env var -- a
  self-hoster, a local run, a fresh environment -- serves $FC_CODE while our
  published copy says $FC_TOML. Set the code default to $FC_TOML."
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
SRV_MS=$(sed -n 's/^export const STUCK_AFTER_MS = \([0-9_]*\);.*/\1/p' src/waitingBuyers.ts | tr -d '_' | head -1)
PAGE_MS=$(sed -n 's/.*waitedMs > \([0-9]*\).*/\1/p' site/pricing/index.html | head -1)
if [ -z "$SRV_MS" ] || [ -z "$PAGE_MS" ]; then
  fail "could not read the buyer-stuck threshold from both sides.
  Expected STUCK_AFTER_MS in src/waitingBuyers.ts and a 'waitedMs > <ms>'
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

# Same one-invariant-across-two-files shape as the buyer-stuck check above, for
# the recurring plan. If the pricing page SELLS a /month subscription, the
# machine must be proven to keep the promise that page makes -- it says the plan
# "cancels itself through Stripe" -- so the cancellation lifecycle must be
# tested. This exists because a live $9/month link sat above a renewal path that
# was 100% broken for its entire life (fixed in 095fc2a), purchasable the whole
# time; zero subscribers was luck. An advertised subscription with no
# cancellation test certifies a promise the machine may silently break.
if grep -qiE '/ ?month' site/pricing/index.html; then
  grep -rqE 'subscription\.deleted|CANCELLATION' test/ \
    || fail "pricing page advertises a /month subscription, but no test covers
  customer.subscription.deleted. The page promises the plan cancels itself; the
  machine must be proven to revoke a cancelled subscriber's pass before it ships.
  Add a cancellation test (test/stripe.test.ts) or remove the /month offer."
  echo "predeploy: /month offer is live and its cancellation lifecycle is tested"
fi

bash scripts/retired-facts.sh || fail "a retired fact is still live in a tracked file"

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

# ---------------------------------------------------------------------------
# VERIFYING WHAT IS ACTUALLY RUNNING, when the metadata is absent or lying.
#
# /healthz now reports build.sha, build.dirty and build.image, baked in at image
# build. That covers the normal case. It does NOT cover the case where the build
# args were forgotten (sha reads "unknown"), or where you have reason to doubt
# the field itself — and "the field that tells you what is deployed" is exactly
# the field you cannot check with itself.
#
# THE FALLBACK IS A MARKER PROBE, and it is how the fa19a82 boundary was
# established on 2026-09-04 before this field existed. Pick a string that only
# ONE SIDE of a commit can contain, then grep the deployed artifact for it:
#
#   fly ssh console -C "grep -c 'someStringAddedByThatCommit' /app/dist/foo.js"
#
# Choosing the marker is the skilled part. It must be present on exactly one
# side of the commit and stable across a build — an identifier or a literal,
# never a comment, since comments do not survive compilation. Probe several
# commits at once and you get a bracket rather than a point: the deployed build
# is at or after the newest marker present and before the oldest marker absent.
#
# This found that /app contained blacklist/address.json while the repo had moved
# to all.json — a one-line fact that three people had been inferring from commit
# timestamps and getting three different answers.
# ---------------------------------------------------------------------------
