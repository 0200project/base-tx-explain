#!/bin/sh
# Retired facts must not survive anywhere a buyer might read them.
#
# THE PROBLEM THIS SOLVES, stated by Surface on 2026-08-27 after their own gate
# missed the README: "a gate scoped to one surface silently certifies every
# surface it doesn't read" — and nobody can enumerate every surface that states
# a fact to a buyer. site/, README, .actor/, docs drafts, script templates: the
# list is open-ended, and every check tonight was scoped to the instance that
# burned us rather than the class. The README shipped four stale claims forty
# minutes after a gate was built specifically to prevent one of them.
#
# THE INVERSION: you cannot enumerate the surfaces, but you CAN enumerate the
# retired facts — because at the moment you retire one, you know exactly what
# the old value was. So this sweeps EVERY tracked file for every retired value,
# and the surface list stops mattering. New surfaces are covered the day they
# are created, automatically, because they are tracked files like any other.
#
# KNOWN BOUNDARY, named so it is not silent (Growth, 2026-08-27): this sweeps
# THIS repo only. The private repo (project-0200) holds outreach drafts — the
# copy-paste surfaces with the highest send-probability — and they are outside
# this gate's reach. Seven queued email drafts carried the retired registry
# name there tonight; Growth's manual pre-send re-read caught them, and that
# re-read is currently the only gate on that side. If a retired fact ever
# ships in an email, this comment is where the gap was known and accepted.
#
# WHEN A FACT RETIRES, add its old value here in the same commit. The allowlist
# is for files whose JOB is to carry the old value: frozen changelog history,
# comments quoting a historical failure, and this file itself.
#
# HONEST LIMIT (found by Surface planting variants, not by reasoning): this
# matches retired VALUES, not retired FACTS. A rephrasing nobody listed — a
# spelled-out number, a reformatted rate — passes clean, so coverage is exactly
# as good as the imagination of whoever wrote the pattern. Add variants when
# found; do not mistake a passing sweep for "no stale claim exists."
#
# Proven both directions before first trust, per the house rule: a planted
# stale claim fails; the clean tree passes.
set -e
cd "$(dirname "$0")/.."

fail=0

check() {
  pattern="$1"; allow="$2"; why="$3"
  hits=$(git ls-files -z | xargs -0 grep -lE "$pattern" 2>/dev/null | grep -vE "$allow" || true)
  if [ -n "$hits" ]; then
    echo ""
    echo "  RETIRED FACT still live: $why"
    echo "$hits" | sed 's/^/    /'
    fail=1
  fi
}

# Free tier was 10 per 30 days until 2026-08-26 (9e46cfb). It is 50 per 24h.
check "first 10 calls|10 free calls|10 calls per client|ten free calls|first ten calls" \
      "^site/changelog/index.html$|^src/freeTier.ts$|^scripts/site-check.sh$|^scripts/retired-facts.sh$" \
      "trial is 50/24h, not 10 (changelog history and the freeTier WHY-comment are exempt by job)"

# Registry entry renamed 2026-08-27; the old name is DELETED from the registry.
check "io.github.0200project/base-tx-explain" \
      "^site/changelog/index.html$|^scripts/retired-facts.sh$" \
      "registry name is io.github.0200project/base-transaction-decoder (changelog history exempt)"

if [ "$fail" -eq 1 ]; then
  echo ""
  echo "  A retired fact is still being stated somewhere a reader could believe it."
  echo "  Fix the file, or - only if its JOB is to record history - add it to the"
  echo "  allowlist here with the reason."
  exit 1
fi
echo "retired-facts: no retired fact is live in any tracked file"
