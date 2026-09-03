#!/bin/sh
# Is it safe to TEMPORARILY modify these tracked files and revert them?
#
# Written after a guard misfired on 2026-09-03. A mutation test -- deliberately
# breaking code to check whether any test fails -- was blocked because
# `git status --short` reported an untracked scratch file in the repo root. A
# `git checkout -- <path>` can never touch an untracked file, so the check
# refused a safe operation for a reason that could not apply.
#
# WHY THAT MATTERS MORE THAN THE MISSED TEST: a guard that fires on the wrong
# signal trains you to override guards, and the training is invisible -- nobody
# notices the moment overriding became reflex. A guard that cries wolf is worse
# than no guard, because it spends the credibility a real block will need.
#
# NOT THE SAME QUESTION AS predeploy.sh, AND THE DIFFERENCE IS THE WHOLE POINT:
#
#   predeploy.sh asks "will the IMAGE contain uncommitted content?" -- and
#   `fly deploy` builds the WORKING DIRECTORY, so an untracked src/*.ts SHIPS,
#   with no commit and no audit trail. There, untracked files are exactly the
#   danger and predeploy.sh is right to block on them. Do not "fix" it to match
#   this script; that would remove the protection it exists to provide.
#
#   This script asks "can I edit these tracked paths and put them back?" -- and
#   revert is `git checkout -- <path>`, which is scoped to tracked content.
#   Untracked files are irrelevant here by construction.
#
# Same command, opposite correct answers, because they are different questions.
#
# Usage:  scripts/safe-to-mutate.sh src/passes.ts [more paths...]

set -e

if [ $# -eq 0 ]; then
  echo "usage: $0 <tracked-path> [more paths...]" >&2
  exit 2
fi

for p in "$@"; do
  if ! git ls-files --error-unmatch -- "$p" >/dev/null 2>&1; then
    echo ""
    echo "  NOT SAFE: '$p' is not tracked by git."
    echo "  There is nothing to revert to. Commit it first, or pick another path."
    echo ""
    exit 1
  fi
done

# Tracked modifications only: staged (M in index) or unstaged (M in worktree).
# Untracked entries are '??' in porcelain and are deliberately NOT matched --
# they cannot be affected by, and cannot survive, a checkout of these paths.
DIRTY=$(git status --porcelain -- "$@" | grep -v '^??' || true)

if [ -n "$DIRTY" ]; then
  echo ""
  echo "$DIRTY"
  echo ""
  echo "  NOT SAFE: uncommitted changes in the paths you want to mutate."
  echo "  Reverting would destroy them. This is someone's work, possibly yours."
  echo ""
  exit 1
fi

echo "safe-to-mutate: $* tracked and clean -- revert with: git checkout -- $*"
