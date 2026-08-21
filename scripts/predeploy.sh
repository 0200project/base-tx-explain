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
