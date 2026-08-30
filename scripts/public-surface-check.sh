#!/bin/sh
# Every tracked file in this PUBLIC repo, checked for COMPANY state.
#
# WHY THIS EXISTS. Three separate cleanups each fixed the category that had just
# burned us — documents got migrated, a handle got replaced, a wallet got moved —
# and each left the others public, because none of them was a gate. A one-time
# sweep cannot prevent recurrence; only something on the push path can.
#
# It scans `git ls-files`, so a file added tomorrow is covered tomorrow. Same
# property that makes retired-facts.sh work.
#
# THE DENYLIST LIVES IN THE PRIVATE REPO ON PURPOSE. A public list of "names we
# must never publish" IS the list of our customers, prospects and identities.
# Publishing the guard would publish the secret. So the names come from
# project-0200, and if that is unreachable this check FAILS CLOSED rather than
# silently skipping the half that matters most.
set -e
FAIL=0
# GUARD THE INVOCATION. `git grep` is relative to the current repo, so running
# this from the PRIVATE repo scans the private tree — where every denylisted
# term legitimately lives — and produces a screenful of false BLOCKs. A gate
# that cries wolf when misinvoked gets distrusted, so refuse instead.
ORIGIN=$(git remote get-url origin 2>/dev/null || echo '')
case "$ORIGIN" in
  *base-tx-explain*) : ;;
  *) echo "  REFUSED: this checks the PUBLIC base-tx-explain repo, but origin is"
     echo "           '${ORIGIN:-<none>}'. cd there and run it again."
     exit 2 ;;
esac
DENY="${NEVER_PUBLISH_FILE:-$HOME/Projects/project-0200/ops/never-publish.txt}"
say() { printf '  %-7s %s\n' "$1" "$2"; }

# --- shape-based: only patterns with near-zero false positives ---------------
#
# NOTE, learned by building this wrong first: do NOT flag "any wallet-shaped
# string". A transaction decoder MUST carry a registry of known protocol
# addresses — Uniswap, Aave, Permit2, the Base system contracts. The first
# version of this check produced 110 hits, all of them product. A gate that
# cries wolf gets switched off, which would have left us with no gate at all.
# OUR addresses are not a shape, they are a list, and the list is private.
if git grep -nIE '(whsec_|sk_live_|ghp_|gho_|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY)' \
     -- . ':!test' ':!*.test.ts' ':!scripts/ci' ':!scripts/public-surface-check.sh' >/dev/null 2>&1; then
  say BLOCK "credential-shaped string outside tests"; FAIL=1
fi

# --- denylist-based: hashed, so the guard is not itself a secret --------------
DENY="${NEVER_PUBLISH_FILE:-$HOME/Projects/project-0200/ops/never-publish.sha256}"
if [ ! -r "$DENY" ]; then
  say BLOCK "denylist unreadable at $DENY — FAILING CLOSED."
  say "" "This check is worthless without it: identities and third-party names"
  say "" "are exactly what it exists to catch. Restore the private repo, or set"
  say "" "NEVER_PUBLISH_FILE, and run again."
  exit 1
fi

# Tokenise every tracked file, salt+hash each token, compare against the list.
# The gate can name the FILE but never the term — which is the point: the guard
# leaks nothing to anything that reads it.
export DENY
HITS=$(git ls-files -z | python3 -c '
import sys, hashlib, re, os
deny_path = os.environ["DENY"]
salt = ""; hashes = set()
for line in open(deny_path, encoding="utf-8"):
    line = line.strip()
    if line.startswith("salt="): salt = line[5:]
    elif line and not line.startswith("#"): hashes.add(line)
data = sys.stdin.buffer.read().split(b"\0")
tok = re.compile(rb"[A-Za-z0-9_]+")
for raw in data:
    if not raw: continue
    path = raw.decode("utf-8", "replace")
    try:
        with open(path, "rb") as fh: blob = fh.read()
    except OSError: continue
    seen = set()
    for m in tok.finditer(blob):
        t = m.group().lower()
        if t in seen: continue
        seen.add(t)
        if hashlib.sha256((salt + t.decode("ascii", "replace")).encode()).hexdigest() in hashes:
            print(path); break
' 2>/dev/null)
if [ -n "$HITS" ]; then
  for f in $HITS; do say BLOCK "denylisted term in: $f"; done
  say "" "(the term is not printed — the denylist is hashed so the guard leaks nothing)"
  FAIL=1
fi

[ "$FAIL" = 1 ] && { echo "  -> public-surface-check FAILED"; exit 1; }
echo "  -> public surface clean"
exit 0
