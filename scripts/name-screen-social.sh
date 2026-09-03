#!/usr/bin/env bash
# name-screen-social.sh — STEP 6 of the naming gauntlet: squatted-handle / impersonation
# surfaces. Growth, 2026-09-02.
#
# WHY THIS EXISTS: this seat asserted these checks "need authenticated APIs I don't have"
# WITHOUT TESTING IT. That was wrong. x.com, npm and github all distinguish taken from free
# unauthenticated, by status code. Controls run 2026-09-02:
#   x.com/github,base,coinbase -> 200 ; two random 14-char strings -> 404
#   github.com/ethereum -> 200 ; random -> 404 ; registry.npmjs.org/react -> 200 ; random -> 404
# Re-run the controls before trusting a batch: a soft-404 change upstream turns every
# candidate "free" silently, which is the failure mode this whole gauntlet exists to prevent.
#
# NOT COVERED, printed as UNKNOWN so the gap stays visible:
#   Telegram, Discord vanity, Farcaster — no reliable unauthenticated existence check found.
#   TRADEMARK — step 9, a human's job, never run against anything.
#
# Usage: ./scripts/name-screen-social.sh NAME [NAME...]

set -uo pipefail
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"

code() { curl -s -o /dev/null -w "%{http_code}" --max-time 12 -A "$UA" "$1"; }
verdict() { # $1=code
  case "$1" in
    200) printf 'TAKEN  ' ;;
    404) printf 'free   ' ;;
    *)   printf 'UNKNOWN' ;;   # 429/403/000 are NOT "free" — never convert UNREACHABLE to CLEAN
  esac
}

printf '%-6s  %-8s %-8s %-8s\n' NAME x.com github npm
for NAME in "$@"; do
  L=$(printf '%s' "$NAME" | tr '[:upper:]' '[:lower:]')
  X=$(code "https://x.com/$L");            sleep 1
  G=$(code "https://github.com/$L")
  N=$(code "https://registry.npmjs.org/$L")
  printf '%-6s  ' "$NAME"
  verdict "$X"; printf ' '; verdict "$G"; printf ' '; verdict "$N"; printf '\n'
done

cat <<'NOTE'

UNKNOWN means the surface did not answer cleanly (429/403/timeout). It is NOT free.
Telegram / Discord / Farcaster: UNKNOWN for every candidate — no unauthenticated check found.
Trademark: never run. A knockout search is a human step and is not clearance.
NOTE
